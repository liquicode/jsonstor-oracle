'use strict';

const LIB_CRYPTO = require( 'crypto' );

const jsongin = require( '@liquicode/jsongin' );
const ORACLE = require( 'oracledb' );


module.exports = {

	AdapterName: 'jsonstor-oracle',
	AdapterDescription: 'Documents are stored in an Oracle database.',

	// ***This package is two primes, so GetAdapter takes a third parameter its siblings do
	// not.*** Each prime passes its own dialect profile; `GetStorage` calls with two arguments
	// and gets the older profile, which is the safe one - every 18.0 rendering runs correctly
	// on 23c and merely pre-filters less. See the profiles at the foot of this file.
	GetAdapter: function ( jsonstor, Settings, Profile )
	{
		if ( jsongin.ShortType( Profile ) !== 'o' ) { Profile = ORACLE_V18_PROFILE; }


		//=====================================================================
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		if ( jsongin.ShortType( Settings.Server ) !== 's' ) { Settings.Server = 'localhost'; }
		if ( jsongin.ShortType( Settings.Port ) !== 'n' ) { Settings.Port = 1521; }
		// ***Database is a service name here and not a database name.*** Oracle reaches a
		// database through a listener service, so the connect string is host:port/service. XE
		// is what the express edition publishes.
		if ( jsongin.ShortType( Settings.Database ) !== 's' ) { throw new Error( `This adapter requires a Settings.Database string parameter, which is the service name.` ); }
		if ( jsongin.ShortType( Settings.Table ) !== 's' ) { throw new Error( `This adapter requires a Settings.Table string parameter.` ); }
		if ( jsongin.ShortType( Settings.UserName ) !== 's' ) { throw new Error( `This adapter requires a Settings.UserName string parameter.` ); }
		if ( jsongin.ShortType( Settings.Password ) !== 's' ) { throw new Error( `This adapter requires a Settings.Password string parameter.` ); }
		// ***A schema is a user in Oracle, which is why this defaults to the user rather than to
		// a name like 'public'.*** The catalog views key on OWNER, and an unquoted identifier
		// folds to upper case when the account is created - so the owner of SYSTEM's tables is
		// 'SYSTEM' whatever case the caller connected with.
		if ( jsongin.ShortType( Settings.Schema ) !== 's' ) { Settings.Schema = Settings.UserName.toUpperCase(); }
		if ( jsongin.ShortType( Settings.IdField ) !== 's' ) { Settings.IdField = ''; }
		if ( jsongin.ShortType( Settings.ModifySchema ) !== 'b' ) { Settings.ModifySchema = false; }
		// The storage model. See jsonx/.plans/sql-adapter-architecture.md - real columns are an
		// index which pre-filters, and the payload column carries the document. With no payload
		// column the table *is* the document, and a field with no column is refused by name.
		if ( jsongin.ShortType( Settings.PayloadColumn ) !== 's' ) { Settings.PayloadColumn = ''; }
		if ( jsongin.ShortType( Settings.PayloadSync ) !== 'b' ) { Settings.PayloadSync = false; }
		if ( jsongin.ShortType( Settings.Columns ) !== 'a' ) { Settings.Columns = []; }


		//=====================================================================
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = jsongin.Clone( Settings );
		Storage.Catalog = {
			initialized: false,
			fields: null,
			id_field: null,
		};


		//=====================================================================
		// The primary key column this adapter creates when it creates a table.
		//
		// ***A length is not optional here.*** Every sibling writes TEXT or VARCHAR and lets the
		// engine decide; Oracle's VARCHAR2 must be told, and it ***enforces*** what it was told.
		// 1000 is comfortably above a uuid and comfortably below the index key limit.
		const DEFAULT_ID_FIELD = '_id';
		const DEFAULT_ID_TYPE = 'VARCHAR2(1000) NOT NULL';

		// ***CLOB rather than a JSON type, for the family's usual reason.*** A parsed form hands
		// back its own key order, so a strict equality against a whole object would compare a
		// document nobody wrote. A CLOB returns the characters which were written.
		const PAYLOAD_TYPE = 'CLOB';

		// The type a declared column gets when the caller names one without a type. 4000 is the
		// largest a VARCHAR2 can be without extended string types being enabled.
		const DEFAULT_COLUMN_TYPE = 'VARCHAR2(4000)';

		// ***Insertion order, and this is the one thing Oracle does exactly as Postgres does.***
		// A) CRUD Tests asserts a collection reads back in the order it was written, and a
		// SELECT with no ORDER BY promises nothing. Oracle has ROWID, but it is a physical
		// address which a row movement changes, so an IDENTITY column is the honest answer -
		// the same answer, and very nearly the same spelling, as jsonstor-postgres.
		//
		// It is never a document field. It is excluded from every row read, every row written,
		// and from the pre-filter. A foreign table has none and is read in the server's order.
		const SEQ_FIELD = '_seq';
		const SEQ_TYPE = 'NUMBER GENERATED BY DEFAULT AS IDENTITY';


		//=====================================================================
		// ***What Oracle does differently, declared in one place.***
		//
		// ***This is the first Wave 1 dialect which is not jsonstor-postgres's.*** It is
		// jsonstor-sqlite's, plus RefusesTypeMismatch, plus one option which did not exist
		// before this adapter. Two engines agreeing was never evidence that a third would.
		const SQL_DIALECT = {
			// Standard SQL, and Oracle is strict about it: an unquoted identifier folds to
			// UPPER case, so a table created as "Test-Table" and then named unquoted is a
			// different table. Every name reaches a statement through quote_identifier.
			IdentifierQuotes: '"',
			StringLiteralQuotes: `'`,
			// A backslash is an ordinary character in an Oracle string literal; the quote is
			// doubled instead, which is standard SQL. Verified: SELECT 'it''s' FROM dual.
			StringLiteralEscape: 'double',
			// Verified against a live server: 'a%b' LIKE 'a\%b' ESCAPE '\' is true.
			LikeEscapeCharacter: '\\',
			LikeEscapeClause: true,
			// ***Oracle has no IS NOT TRUE***, which is where this dialect stops being
			// Postgres's and becomes SQLite's. `((1 = 1) IS NOT TRUE)` answers
			// ORA-00907: missing right parenthesis. So a negation is written the long way:
			//     oracle    ((NOT ("a" >= 0)) OR "a" IS NULL)
			//     postgres  (("a" >= 0) IS NOT TRUE)
			// ***Measured on 2026-09-01: 18.0 and 21.3 refuse it and 23.26 accepts it.***
			NegateWithIsNotTrue: Profile.HasBoolean,
			// ***And the portable form does not run here either, which is the discovery this
			// adapter cost.*** `((NOT ("n" >= 0)) OR ("n" >= 0) IS NULL)` answers the same
			// ORA-00907, because Oracle has no boolean expression type: a comparison cannot
			// appear where a value is wanted, which rules out both of the forms that existed.
			// A CASE takes a condition and can tell TRUE from FALSE and UNKNOWN, so it is the
			// spelling here. See negate() in jsonstor's SqlExpression.js.
			//
			// ***23c is where that stops being true.*** It has a real boolean expression type,
			// so `IS NOT TRUE` runs and the CASE is no longer needed.
			NegateWithCaseExpression: !Profile.HasBoolean,
			// ***Left unrendered on purpose.*** Oracle can express both, and so can every
			// sibling which declares them false: a rendering is trusted once a live server of
			// that dialect has licensed it, and per-dialect parity is deferred. Dropping them
			// broadens, which costs time and never an answer.
			RendersModulo: false,
			RendersBitwise: false,
			// ***This engine throws where SQLite and MySQL coerce.*** A comparison of a NUMBER
			// column against 'not-a-number' answers ORA-01722: invalid number, and an aborted
			// statement returns nothing for jsongin to filter - so the caller would get an error
			// instead of a broad answer. Declaring this drops the predicate instead.
			RefusesTypeMismatch: true,
			// ***Oracle before 23c has no BOOLEAN type and no boolean literal.*** `("b" = TRUE)`
			// answers ORA-00904: "TRUE": invalid identifier, because TRUE is read as a column
			// name. A boolean lives in a one digit number here and compares against 1 and 0.
			//
			// ***This is the option Wave 1 was not supposed to need.*** The roadmap's claim was
			// that four SQL dialects would cost nothing but settings on a translator which
			// already existed, and that held for Postgres and DuckDB exactly. It did not hold
			// here. See jsonx/.plans/story.md.
			//
			// ***And it is the option which made this package a family.*** 23c has the type and
			// the literals, which is the boundary the whole versioned-adapter scheme was built
			// from. Measured on 2026-09-01: 23.26 takes `"b" = TRUE` and `"b" = 1` both.
			BooleanLiterals: Profile.HasBoolean ? 'keyword' : 'number',
		};


		//=====================================================================
		// ***What a NUMBER column will actually hold.***
		//
		// Oracle spells an integer as a NUMBER with a scale of zero, so there is no list of type
		// names to match the way there is for the siblings - the precision and scale in the
		// catalog are the answer. NUMBER(10) holds ten digits and refuses an eleventh with
		// ORA-01438; a bare NUMBER has no precision, no scale, and holds 1.5 happily.
		//
		// ***Capped at JavaScript's safe integer whatever the column allows***, because a
		// document is JSON and jsongin's numbers are JavaScript numbers. A NUMBER(19) could hold
		// more than 2^53-1, and a value which could not survive the round trip belongs in the
		// payload rather than in a column which would return a different number.
		const MAX_SAFE = 9007199254740991;

		function integer_range( Field )
		{
			if ( !Number.isInteger( Field.precision ) ) { return { Low: -MAX_SAFE, High: MAX_SAFE }; }
			let limit = Math.pow( 10, Field.precision ) - 1;
			if ( limit > MAX_SAFE ) { limit = MAX_SAFE; }
			return { Low: -limit, High: limit };
		}


		//=====================================================================
		// ***Whether there is a 'b' here is a fact about the server version rather than an
		// omission.*** Oracle has no BOOLEAN column type before 23c, so no column can be
		// declared to hold one, so no boolean value ever fits a column - it goes to the payload
		// with a NULL left behind, and F4's broadening admits the row. The cost is that a
		// boolean predicate never pre-filters on the older profile.
		//
		// ***This is the site which proves a dialect is not the translator's business alone.***
		// The catalog reports `BOOLEAN` on 23.26 and the profile is what decides whether this
		// adapter believes it, so the same fact is read here, in ColumnTypes and in
		// value_to_parameter. Measured on 2026-09-01.
		function short_type_of( DataType )
		{
			let type = ( jsongin.ShortType( DataType ) === 's' ) ? DataType.toUpperCase() : '';
			if ( Profile.HasBoolean && ( type === 'BOOLEAN' ) ) { return 'b'; }
			if ( type === 'NUMBER' ) { return 'n'; }
			if ( type === 'FLOAT' ) { return 'n'; }
			if ( type === 'BINARY_FLOAT' ) { return 'n'; }
			if ( type === 'BINARY_DOUBLE' ) { return 'n'; }
			if ( type === 'VARCHAR2' ) { return 's'; }
			if ( type === 'NVARCHAR2' ) { return 's'; }
			if ( type === 'CHAR' ) { return 's'; }
			if ( type === 'NCHAR' ) { return 's'; }
			// Everything else - CLOB, BLOB, DATE, TIMESTAMP, a user type. Deliberately outside
			// the 'bns' set SQL_Query pre-filters on: nothing here knows how this engine
			// compares those, and a clause it cannot reason about could narrow. The payload
			// column is a CLOB and lands here, which is correct - it is never pre-filtered on.
			return '?';
		}


		//=====================================================================
		// An identifier, quoted the way Oracle quotes one. Doubles an embedded double quote,
		// which is the only escape available.
		function quote_identifier( Name )
		{
			if ( jsongin.ShortType( Name ) !== 's' ) { throw new Error( `An identifier must be a string.` ); }
			return '"' + Name.split( '"' ).join( '""' ) + '"';
		}


		//=====================================================================
		// The table, as the statements name it. Schema qualified, so a statement does not
		// depend on which user the session connected as.
		function table_reference()
		{
			return quote_identifier( Storage.Settings.Schema ) + '.' + quote_identifier( Storage.Settings.Table );
		}


		//=====================================================================
		// ***One connection, held for the life of the storage - measured rather than
		// inherited.***
		//
		// jsonstor-postgres opens one per statement because the Storage interface has no Close,
		// so a pg handle would sit in the event loop and a test run would hang after its last
		// assertion passed. That argument is about pg, not about servers, and it does not hold
		// here: a process holding an open oracledb connection ***exits on its own***.
		//
		// And the cost of not holding it is real. Measured against the live server: 105ms for
		// the first connection and about 30ms for each one after, against 6ms for a statement
		// on a connection which is already open. Opening per statement would have made the
		// slowest adapter in the family slower still, for a safety property it does not need.
		//
		// Opened through a promise rather than a flag, so two concurrent first calls cannot each
		// open one and leave the loser's connection unreachable.
		const HELD = { promise: null };

		async function held_connection()
		{
			if ( !HELD.promise )
			{
				HELD.promise = ( async function ()
				{
					let connection = await ORACLE.getConnection( {
						user: Storage.Settings.UserName,
						password: Storage.Settings.Password,
						connectString: Storage.Settings.Server + ':' + Storage.Settings.Port + '/' + Storage.Settings.Database,
					} );
					// ***Every statement commits.*** The Storage interface has no transaction,
					// so a connection left in one would hold locks nothing will ever release.
					connection.autoCommit = true;
					return connection;
				} )();
			}
			return await HELD.promise;
		}


		//=====================================================================
		// ***A CLOB arrives as a readable stream, not a string.***
		//
		// This is Oracle's version of the trap pg sets with bigint and DuckDB sets with BigInt,
		// and it is the loudest of the three: JSON.stringify on the returned object throws
		// `Converting circular structure to JSON` rather than quietly giving the wrong value.
		// The payload column is a CLOB, so every read would hit it.
		//
		// Asked per statement rather than by setting oracledb.fetchAsString globally, because
		// that property belongs to the driver and this adapter is a guest in someone's process.
		function fetch_type_handler( MetaData )
		{
			if ( MetaData.dbType === ORACLE.DB_TYPE_CLOB ) { return { type: ORACLE.STRING }; }
			if ( MetaData.dbType === ORACLE.DB_TYPE_NCLOB ) { return { type: ORACLE.STRING }; }
			return undefined;
		}


		//=====================================================================
		// SQL_Passthrough
		//
		// The one place a statement runs. Normalized to the { results, info } shape the sibling
		// adapters answer with, so that a caller reads the same way in all five.
		// ***The dialect is checked against the server once, on the first statement.***
		//
		// The connection is lazy and `GetStorage` is synchronous, so a mismatched server cannot
		// be caught at construction and surfaces on the first operation instead. ***The outcome
		// is remembered, so every later call fails the same way***: a storage pointed at a
		// server its dialect cannot serve is wrong for its whole life, not only once.
		//
		// ***A server which did not answer is not remembered***, because that is a transient
		// failure rather than an answer, and caching it would poison the storage.
		let dialect_check = null;
		async function ensure_dialect_checked()
		{
			if ( dialect_check !== null )
			{
				if ( dialect_check.Error ) { throw dialect_check.Error; }
				return;
			}
			// Set before asking, so that StorageInfo's own statement does not re-enter this.
			dialect_check = {};
			try { await Storage.StorageInfo(); }
			catch ( error )
			{
				if ( error && error.DialectBoundary ) { dialect_check.Error = error; }
				else { dialect_check = null; }
				throw error;
			}
			return;
		}


		async function SQL_Passthrough( SqlStatement, SqlParameters = [] )
		{
			await ensure_dialect_checked();
			let connection = await held_connection();
			let result = await connection.execute( SqlStatement, SqlParameters, {
				outFormat: ORACLE.OUT_FORMAT_OBJECT,
				fetchTypeHandler: fetch_type_handler,
			} );
			// A query answers rows; a DML statement answers a count and no rows at all.
			if ( result.rows )
			{
				return { results: result.rows, info: { changes: result.rows.length }, out: result.outBinds };
			}
			return { results: [], info: { changes: result.rowsAffected || 0 }, out: result.outBinds };
		}


		//=====================================================================
		// DDL, which takes no parameters and returns no rows.
		async function SQL_Execute( SqlStatement )
		{
			await SQL_Passthrough( SqlStatement, [] );
			return true;
		}


		//=====================================================================
		// ***Oracle has no DROP TABLE IF EXISTS before 23c***, and no CREATE TABLE IF NOT
		// EXISTS at all. The catalog answers the second question, and this answers the first:
		// ORA-00942 is 'table or view does not exist', which is the outcome asked for.
		async function SQL_Execute_Ignoring_Missing( SqlStatement )
		{
			try { await SQL_Execute( SqlStatement ); }
			catch ( error )
			{
				if ( ( '' + error.message ).includes( 'ORA-00942' ) ) { return false; }
				throw error;
			}
			return true;
		}


		//=====================================================================
		// A value on its way into a bound parameter.
		//
		// ***A boolean has no binding before 23c.*** oracledb answers ORA-00932: inconsistent
		// datatypes: expected NUMBER got BOOLEAN. Nothing should reach this with one on that
		// profile, because no column can hold a boolean there - see short_type_of - but
		// converting is cheaper than a thrown driver error if a foreign table ever surprises us.
		//
		// ***23c binds one directly***, measured on 2026-09-01, so converting there would write
		// a number into a column which holds a boolean and read back the wrong type.
		function value_to_parameter( Value )
		{
			if ( typeof Value === 'undefined' ) { return null; }
			if ( Profile.HasBoolean ) { return Value; }
			if ( Value === true ) { return 1; }
			if ( Value === false ) { return 0; }
			return Value;
		}


		//=====================================================================
		// The :1, :2 tokens an Oracle statement binds with.
		function parameter_token( Index )
		{
			return ':' + Index;
		}


		//=====================================================================
		async function update_catalog()
		{
			if ( Storage.Catalog.initialized ) { return Storage.Catalog; }
			Storage.Catalog.initialized = true;
			Storage.Catalog.table_exists = false;
			Storage.Catalog.fields = {};
			Storage.Catalog.id_field = Storage.Settings.IdField;
			Storage.Catalog.order_by = null;
			Storage.Catalog.payload_field = null;

			// ***Oracle has no information_schema.*** The ALL_ views are the equivalent and they
			// are named and shaped differently from the standard ones every sibling reads.
			let table_rows = await SQL_Passthrough(
				`SELECT table_name FROM all_tables WHERE ((owner = :1) AND (table_name = :2))`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			if ( !table_rows.results.length ) { return Storage.Catalog; }
			Storage.Catalog.table_exists = true;

			let key_rows = await SQL_Passthrough(
				`SELECT cc.column_name
					FROM all_constraints uc
					JOIN all_cons_columns cc
						ON ( ( cc.constraint_name = uc.constraint_name ) AND ( cc.owner = uc.owner ) )
					WHERE ( ( uc.owner = :1 ) AND ( uc.table_name = :2 ) AND ( uc.constraint_type = 'P' ) )
					ORDER BY cc.position`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			let primary_keys = {};
			for ( let index = 0; index < key_rows.results.length; index++ )
			{
				primary_keys[ key_rows.results[ index ].COLUMN_NAME ] = true;
			}

			let columns = await SQL_Passthrough(
				`SELECT column_name, data_type, data_length, data_precision, data_scale, nullable, identity_column
					FROM all_tab_columns
					WHERE ( ( owner = :1 ) AND ( table_name = :2 ) )
					ORDER BY column_id`,
				[ Storage.Settings.Schema, Storage.Settings.Table ] );
			for ( let index = 0; index < columns.results.length; index++ )
			{
				let column = columns.results[ index ];
				let data_type = column.DATA_TYPE || '';
				let scale = column.DATA_SCALE;
				let field = {
					name: column.COLUMN_NAME,
					type_name: data_type,
					short_type: short_type_of( data_type ),
					allow_null: ( column.NULLABLE === 'Y' ),
					is_primary_key: !!primary_keys[ column.COLUMN_NAME ],
					// ***An integer is a NUMBER whose scale is zero***, which is a property of
					// the column rather than of its type name. A bare NUMBER has no scale at
					// all and is not an integer column - it stores 1.5 unchanged.
					is_integer: ( data_type.toUpperCase() === 'NUMBER' ) && ( scale === 0 ),
					precision: column.DATA_PRECISION,
					is_identity: ( column.IDENTITY_COLUMN === 'YES' ),
					is_auto_increment: ( column.IDENTITY_COLUMN === 'YES' ),
					// ***VARCHAR2 enforces its length***, unlike DuckDB and like Postgres, so
					// this is a real constraint and value_fits_column checks it.
					max_length: ( 's'.includes( short_type_of( data_type ) ) ) ? column.DATA_LENGTH : null,
				};
				Storage.Catalog.fields[ column.COLUMN_NAME ] = field;
			}

			// A configured IdField wins, then _id by name, and only then a foreign table's
			// identity key. The _seq column is never the identity - it carries insertion order
			// and this adapter creates it alongside a VARCHAR2 primary key.
			if ( !Storage.Catalog.id_field && Storage.Catalog.fields[ DEFAULT_ID_FIELD ] )
			{
				Storage.Catalog.id_field = DEFAULT_ID_FIELD;
			}
			if ( !Storage.Catalog.id_field )
			{
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === SEQ_FIELD ) { continue; }
					if ( !Storage.Catalog.fields[ key ].is_auto_increment ) { continue; }
					Storage.Catalog.id_field = key;
					break;
				}
			}
			if ( !Storage.Catalog.id_field )
			{
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === SEQ_FIELD ) { continue; }
					if ( !Storage.Catalog.fields[ key ].is_primary_key ) { continue; }
					Storage.Catalog.id_field = key;
					break;
				}
			}

			// Insertion order. See SEQ_FIELD.
			if ( Storage.Catalog.fields[ SEQ_FIELD ] ) { Storage.Catalog.order_by = SEQ_FIELD; }

			// The payload column, if this storage was configured with one and the table has it.
			if ( Storage.Settings.PayloadColumn )
			{
				Storage.Catalog.payload_field =
					Storage.Catalog.fields[ Storage.Settings.PayloadColumn ] || null;
			}

			return Storage.Catalog;
		}


		//=====================================================================
		// ensure_schema
		//
		// ***jsonstor never infers a column from a document.*** Columns come from the Columns
		// declaration when this adapter creates the table, or from the table as it was found.
		// Nothing else. See jsonx/.plans/sql-adapter-architecture.md, rule R2.
		//=====================================================================
		async function ensure_schema()
		{
			if ( !Storage.Catalog.initialized ) { await update_catalog(); }
			if ( !Storage.Settings.ModifySchema ) { return; }

			let changed = false;

			if ( !Storage.Catalog.table_exists )
			{
				// ***No CREATE SCHEMA here, and that is not an omission.*** A schema in Oracle
				// is a user, created with CREATE USER and a quota and a password. That is an
				// administrative act rather than something a storage adapter should do on the
				// strength of a boolean setting, so the schema must already exist.
				let id_column = declared_id_column();
				let sql = `CREATE TABLE ${table_reference()} (`
					+ ` ${quote_identifier( id_column.Name )} ${id_column.Type} PRIMARY KEY,`
					+ ` ${quote_identifier( SEQ_FIELD )} ${SEQ_TYPE} )`;
				await SQL_Execute( sql );
				Storage.Catalog.initialized = false;
				await update_catalog();
				changed = true;
			}

			// Every declared column which is not there yet, then the payload column. Declared
			// columns carry their SQL type verbatim: this is a SQL adapter, and a caller who
			// names a table also names its types.
			let additions = [];
			for ( let index = 0; index < Storage.Settings.Columns.length; index++ )
			{
				let column = Storage.Settings.Columns[ index ];
				if ( jsongin.ShortType( column ) !== 'o' ) { continue; }
				if ( jsongin.ShortType( column.Name ) !== 's' ) { continue; }
				if ( !column.Name ) { continue; }
				if ( column.Key ) { continue; }
				if ( Storage.Catalog.fields[ column.Name ] ) { continue; }
				let type = ( jsongin.ShortType( column.Type ) === 's' ) ? column.Type : DEFAULT_COLUMN_TYPE;
				additions.push( { Name: column.Name, Type: type } );
			}
			if ( Storage.Settings.PayloadColumn && !Storage.Catalog.fields[ Storage.Settings.PayloadColumn ] )
			{
				additions.push( { Name: Storage.Settings.PayloadColumn, Type: PAYLOAD_TYPE } );
			}

			// ***Oracle takes a list too, but spells it differently.*** MySQL and Postgres write
			// a comma separated run of ADD COLUMN clauses; Oracle writes one ADD with the
			// columns parenthesized. Either way it is one statement, so the table is never
			// observed half altered - which DuckDB, alone in this family, cannot promise.
			if ( additions.length )
			{
				let clauses = [];
				for ( let index = 0; index < additions.length; index++ )
				{
					clauses.push( `${quote_identifier( additions[ index ].Name )} ${additions[ index ].Type}` );
				}
				await SQL_Execute( `ALTER TABLE ${table_reference()} ADD ( ${clauses.join( ', ' )} )` );
				changed = true;
			}

			if ( changed )
			{
				Storage.Catalog.initialized = false;
				await update_catalog();
			}
			return;
		}


		//=====================================================================
		// The primary key column this adapter creates.
		function declared_id_column()
		{
			for ( let index = 0; index < Storage.Settings.Columns.length; index++ )
			{
				let column = Storage.Settings.Columns[ index ];
				if ( jsongin.ShortType( column ) !== 'o' ) { continue; }
				if ( !column.Key ) { continue; }
				if ( jsongin.ShortType( column.Name ) !== 's' ) { continue; }
				if ( !column.Name ) { continue; }
				let type = ( jsongin.ShortType( column.Type ) === 's' ) ? column.Type : DEFAULT_ID_TYPE;
				return { Name: column.Name, Type: type };
			}
			let name = Storage.Settings.IdField || DEFAULT_ID_FIELD;
			return { Name: name, Type: DEFAULT_ID_TYPE };
		}


		//=====================================================================
		// Whether a column can hold this value without changing it.
		//
		// ***Oracle is the strictest engine in the family, and it is strict in both directions.***
		// It rounds a fractional value into a scale-zero NUMBER the way Postgres and DuckDB do -
		// measured, 1.5 into NUMBER(10) stores 2 - and it ***refuses*** an over precision number
		// with ORA-01438 and an over length string with ORA-12899 rather than truncating.
		//
		// Rounding is the one which costs an answer. Under PayloadSync a column is a projection
		// of the payload and F4 broadens every predicate on it with IS NULL, so a value the
		// column could not hold is admitted by that NULL - but a rounded value is not NULL. It
		// is a wrong number sitting where a right one should be, the clause compares against it,
		// and the row never travels. The refusals are the milder case: they would fail a write
		// the payload could have carried.
		//
		// ***A boolean never fits, because no column here can be declared to hold one.***
		function value_fits_column( Field, Value )
		{
			let st = jsongin.ShortType( Value );
			if ( !'bns'.includes( st ) ) { return false; }
			if ( Field.short_type !== st ) { return false; }
			if ( st === 'n' )
			{
				if ( !Number.isFinite( Value ) ) { return false; }
				if ( Field.is_integer )
				{
					if ( !Number.isInteger( Value ) ) { return false; }
					let range = integer_range( Field );
					if ( ( Value < range.Low ) || ( Value > range.High ) ) { return false; }
				}
				else if ( ( Value > MAX_SAFE ) || ( Value < -MAX_SAFE ) ) { return false; }
			}
			if ( st === 's' )
			{
				if ( Number.isInteger( Field.max_length ) && ( Value.length > Field.max_length ) ) { return false; }
			}
			return true;
		}


		//=====================================================================
		function parse_payload( Value )
		{
			if ( ( Value === null ) || ( typeof Value === 'undefined' ) ) { return {}; }
			if ( typeof Value === 'string' )
			{
				if ( !Value ) { return {}; }
				return JSON.parse( Value );
			}
			return Value;
		}


		//=====================================================================
		function serialize_payload( Value )
		{
			return JSON.stringify( Value );
		}


		//=====================================================================
		// document_to_row
		//
		// Splits a document into the columns which pre-filter and the payload which stores it,
		// according to the three configurations in the architecture document.
		function document_to_row( Document )
		{
			let payload_name = Storage.Settings.PayloadColumn;
			let has_payload = ( Storage.Catalog.payload_field !== null );
			let row = {};

			if ( has_payload && Storage.Settings.PayloadSync )
			{
				// F3. The payload is the whole document and the columns are projections of it,
				// each holding the value when it fits and NULL when it does not. Reads never
				// take a value from a column, so a NULL here costs a pre-filter and not an
				// answer - SqlExpression broadens a projected column for exactly that reason.
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === payload_name ) { continue; }
					if ( key === SEQ_FIELD ) { continue; }
					let field = Storage.Catalog.fields[ key ];
					if ( field.is_auto_increment ) { continue; }
					if ( key === Storage.Catalog.id_field ) { continue; }
					let value = Document[ key ];
					row[ key ] = value_fits_column( field, value ) ? value : null;
				}
				row[ payload_name ] = serialize_payload( Document );
				return row;
			}

			let remainder = {};
			for ( let key in Document )
			{
				if ( key.includes( '.' ) ) { continue; }
				if ( key === payload_name )
				{
					throw new Error( `Cannot store a field named [${key}], it is this storage's payload column.` );
				}
				let value = Document[ key ];
				let field = Storage.Catalog.fields[ key ];
				if ( !field )
				{
					// F1. A field with no column is refused rather than dropped.
					if ( !has_payload )
					{
						throw new Error( `Cannot store the field [${key}], the table [${Storage.Settings.Table}] has no such column and this storage has no payload column.` );
					}
					remainder[ key ] = value;
					continue;
				}
				if ( key === SEQ_FIELD ) { continue; }
				if ( field.is_auto_increment ) { continue; }
				if ( key === Storage.Catalog.id_field ) { continue; }
				if ( jsongin.ShortType( value ) === 'l' ) { row[ key ] = null; continue; }
				if ( !value_fits_column( field, value ) )
				{
					// F2. The column is the only home this field has, so a value it cannot hold
					// is refused rather than coerced into a lie.
					throw new Error( `Cannot store the field [${key}], its value does not fit the column's type [${field.type_name}]. Configure a PayloadColumn to store values of any type.` );
				}
				row[ key ] = value;
			}
			if ( has_payload ) { row[ payload_name ] = serialize_payload( remainder ); }
			return row;
		}


		//=====================================================================
		function row_to_document( Row )
		{
			if ( !Row ) { return null; }
			let payload_name = Storage.Settings.PayloadColumn;
			let has_payload = ( Storage.Catalog.payload_field !== null );

			// F3. Under PayloadSync the payload is the document and the columns are projections
			// of it, so a value is never taken from a column. That is the whole reason this
			// configuration keeps absent apart from null and a number apart from its string:
			// the payload is real JSON and a column is not.
			if ( has_payload && Storage.Settings.PayloadSync )
			{
				return parse_payload( Row[ payload_name ] );
			}

			// The columns are the document here, so the round trip is only as good as they are,
			// and on this engine that is worse than on the others: Oracle stores an empty string
			// as NULL, so a field which held '' reads back null in this configuration. The
			// payload configurations do not have that problem because the payload is real JSON.
			let document = {};
			for ( let key in Row )
			{
				if ( has_payload && ( key === payload_name ) ) { continue; }
				// Insertion order is storage bookkeeping and never a field of the document.
				if ( key === SEQ_FIELD ) { continue; }
				document[ key ] = Row[ key ];
			}
			document = jsongin.Unhybridize( document );
			if ( has_payload )
			{
				let remainder = parse_payload( Row[ payload_name ] );
				for ( let key in remainder ) { document[ key ] = remainder[ key ]; }
			}
			return document;
		}


		//=====================================================================
		// ***Options is threaded in rather than held in a closure.*** It carries the statistics
		// collector for this one call, and a variable on the Storage would blend two overlapping
		// calls into one meaningless pair of numbers.
		async function SQL_Query( Criteria, MaxDocs = 0, Options = null )
		{
			// A malformed criteria is refused, not answered - the same rule the built in
			// adapters apply. Without it a criteria of the wrong type reaches SqlExpression
			// and comes back as an empty clause, which reads as "match everything".
			let st_criteria = jsongin.ShortType( Criteria );
			if ( !'olu'.includes( st_criteria ) ) { throw new Error( `Criteria must be an object, null, or undefined.` ); }

			await update_catalog();
			if ( !Storage.Catalog.table_exists ) { return []; }

			// Convert criteria to an sql expression.
			let sql_expression_options = Object.assign( {}, SQL_DIALECT );
			sql_expression_options.AllowedFields = {};
			let payload_sync = ( Storage.Catalog.payload_field !== null ) && Storage.Settings.PayloadSync;
			for ( let key in Storage.Catalog.fields )
			{
				let field = Storage.Catalog.fields[ key ];
				if ( field.is_auto_increment ) { continue; }
				if ( key === SEQ_FIELD ) { continue; }
				if ( key === Storage.Settings.PayloadColumn ) { continue; }
				if ( !'bns'.includes( field.short_type ) ) { continue; }
				// ***The key column is left out under PayloadSync.*** It holds String( _id ), so
				// an ordering criteria on a numeric _id would compare "10" against "5" as text
				// and lose rows. The by-id paths build their own WHERE and still use the index.
				if ( payload_sync && ( key === Storage.Catalog.id_field ) ) { continue; }
				let entry = jsongin.Clone( field );
				// F4. A projected column mirrors the payload and holds NULL where the value did
				// not fit, so every predicate on it is broadened with IS NULL.
				entry.is_projection = payload_sync;
				sql_expression_options.AllowedFields[ key ] = entry;
			}
			// ***The clause narrows the search; the residual decides the answer.***
			// Today the residual is the whole criteria, so the filtering below is
			// unchanged - but reading it from the translation rather than closing over
			// Criteria is what lets a translator earn a narrower one without this
			// adapter changing again.
			let translation = jsonstor.SqlExpression.Translate( {
				Criteria: Criteria,
				Options: sql_expression_options,
			} );
			let sql_expr = translation.Pushdown;

			// Build sql statement.
			let sql = `SELECT * FROM ${table_reference()}`;
			if ( sql_expr ) { sql += ' WHERE ' + sql_expr; }
			// ***A listing is not sorted unless it says so.*** See SEQ_FIELD.
			if ( Storage.Catalog.order_by )
			{
				sql += ' ORDER BY ' + quote_identifier( Storage.Catalog.order_by );
			}

			// Get results.
			let results = await SQL_Passthrough( sql );
			let documents = results.results;

			// Do the actual query filtering here.
			let filtered = [];
			for ( let index = 0; index < documents.length; index++ )
			{
				let document = row_to_document( documents[ index ] );
				if ( jsongin.Query( document, translation.Residual ) )
				{
					filtered.push( document );
					if ( MaxDocs && ( filtered.length === MaxDocs ) ) { break; }
				}
			}

			// ***What the two stages actually did.*** A no-op unless the caller asked for it.
			// PushdownRows is what the server sent; ResidualRows is what this call produced,
			// which a MaxDocs limit stops early - FindOne reports 1 however many matched.
			jsonstor.ReportStatistics( Options, {
				Translator: Storage.SqlTranslation.TranslatorName,
				Pushdown: sql_expr || null,
				PushdownRows: documents.length,
				Residual: translation.Residual,
				ResidualRows: filtered.length,
			} );

			// Return the results.
			return filtered;
		}


		//=====================================================================
		// The value which goes in the key column.
		//
		// The payload carries the true _id with its true type; this is only what the index
		// holds. A VARCHAR2 key takes String() so that the by-id statements compare like with
		// like.
		function id_to_key( Value )
		{
			if ( ( Value === null ) || ( typeof Value === 'undefined' ) ) { return null; }
			let field = Storage.Catalog.fields[ Storage.Catalog.id_field ];
			if ( field && 'n'.includes( field.short_type ) ) { return Value; }
			return '' + Value;
		}


		//=====================================================================
		function new_id()
		{
			// jsongin's _id is a uuid string, and the built in adapters mint one with uuid.v4()
			// when a document arrives without it. randomUUID is the same value from the runtime,
			// which keeps this adapter's dependencies to its driver.
			return LIB_CRYPTO.randomUUID();
		}


		//=====================================================================
		async function select_by_id( Key )
		{
			let sql = `SELECT * FROM ${table_reference()} WHERE (${quote_identifier( Storage.Catalog.id_field )} = ${parameter_token( 1 )})`;
			let results = await SQL_Passthrough( sql, [ value_to_parameter( Key ) ] );
			if ( !results.results.length ) { return null; }
			return row_to_document( results.results[ 0 ] );
		}


		//=====================================================================
		async function SQL_Insert( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();
			await ensure_schema();

			if ( !Storage.Catalog.table_exists ) { throw new Error( `Cannot insert rows into table [${Storage.Settings.Table}], it does not exist. Set ModifySchema to true to have it created.` ); }
			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot insert rows into table [${Storage.Settings.Table}], a primary key field was not found. ` ); }
			let id_field = Storage.Catalog.id_field;
			let id_column = Storage.Catalog.fields[ id_field ];
			let auto_increment = !!( id_column && id_column.is_auto_increment );

			// ***The caller's _id is taken as given.*** Only an auto-increment key gets to
			// choose one, and then it is the server which chooses it.
			let document = Document;
			if ( !auto_increment && ( jsongin.ShortType( document[ id_field ] ) === 'u' ) )
			{
				document = jsongin.Clone( Document );
				document[ id_field ] = new_id();
			}

			let row = document_to_row( document );
			if ( !auto_increment ) { row[ id_field ] = id_to_key( document[ id_field ] ); }

			let columns = Object.keys( row );
			if ( columns.length === 0 ) { return null; }

			let names = [];
			let tokens = [];
			let sql_parameters = [];
			for ( let index = 0; index < columns.length; index++ )
			{
				names.push( quote_identifier( columns[ index ] ) );
				tokens.push( parameter_token( index + 1 ) );
				sql_parameters.push( value_to_parameter( row[ columns[ index ] ] ) );
			}
			let sql = `INSERT INTO ${table_reference()} ( ${names.join( ', ' )} ) VALUES ( ${tokens.join( ', ' )} )`;

			// ***RETURNING is only asked for when the server chose the key.*** Oracle spells it
			// `RETURNING <col> INTO <bind>` and needs an OUT bind declared for it, unlike
			// Postgres where RETURNING is just another result set. When this adapter already
			// knows the key there is nothing to ask for, so the common path stays a plain
			// INSERT.
			if ( auto_increment )
			{
				sql += ` RETURNING ${quote_identifier( id_field )} INTO ${parameter_token( columns.length + 1 )}`;
				let out_type = ( id_column && id_column.short_type === 'n' ) ? ORACLE.NUMBER : ORACLE.STRING;
				sql_parameters.push( { dir: ORACLE.BIND_OUT, type: out_type } );
			}

			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return null; }

			let key = row[ id_field ];
			if ( auto_increment )
			{
				// outBinds is an array of arrays here - one array per RETURNING row.
				let out = results.out;
				if ( out && out.length && out[ 0 ] && out[ 0 ].length ) { key = out[ 0 ][ 0 ]; }
			}
			return await select_by_id( key );
		}


		//=====================================================================
		async function SQL_Update( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();
			await ensure_schema();

			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot update rows in table [${Storage.Settings.Table}], a primary key field was not found.` ); }
			let id_field = Storage.Catalog.id_field;
			if ( jsongin.ShortType( Document[ id_field ] ) === 'u' ) { throw new Error( `Cannot update this document, it is missing the id field [${id_field}].` ); }

			let row = document_to_row( Document );
			delete row[ id_field ];
			let columns = Object.keys( row );
			if ( columns.length === 0 ) { return null; }

			let tokens = [];
			let sql_parameters = [];
			for ( let index = 0; index < columns.length; index++ )
			{
				tokens.push( `${quote_identifier( columns[ index ] )} = ${parameter_token( index + 1 )}` );
				sql_parameters.push( value_to_parameter( row[ columns[ index ] ] ) );
			}
			let key = id_to_key( Document[ id_field ] );
			let sql = `UPDATE ${table_reference()} SET ${tokens.join( ', ' )}`
				+ ` WHERE (${quote_identifier( id_field )} = ${parameter_token( columns.length + 1 )})`;
			sql_parameters.push( value_to_parameter( key ) );

			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return null; }

			return await select_by_id( key );
		}


		//=====================================================================
		async function SQL_Delete( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();

			// Get the _id field.
			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot delete rows from table [${Storage.Settings.Table}], a primary key field was not found.` ); }
			if ( jsongin.ShortType( Document[ Storage.Catalog.id_field ] ) === 'u' ) { throw new Error( `Cannot delete this document, it is missing the id field [${Storage.Catalog.id_field}].` ); }

			let sql = `DELETE FROM ${table_reference()} WHERE (${quote_identifier( Storage.Catalog.id_field )} = ${parameter_token( 1 )})`;
			let sql_parameters = [ value_to_parameter( id_to_key( Document[ Storage.Catalog.id_field ] ) ) ];

			// Get results.
			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return false; }

			return true;
		}


		//=====================================================================
		// SqlTranslation
		//
		// ***What a clause-translating adapter advertises beyond the Storage interface.***
		// This is how a shared suite, or any other caller, can ask what this adapter would
		// render and then ask the server what that rendering admits.
		//
		// ***Its presence is the capability declaration.*** An adapter which does not push a
		// clause down does not define it, and a suite which needs one skips that engine
		// rather than consulting a second list somewhere which could disagree.
		//=====================================================================

		Storage.SqlTranslation = {
			TranslatorName: 'SqlExpression',
			DialectName: 'oracle',

			// The options this adapter renders with. A copy, so a caller cannot alter them.
			Dialect: function () { return Object.assign( {}, SQL_DIALECT ); },

			// ***A logical type to this engine's spelling for it.*** A shared suite declares the
			// columns it wants in jsongin's own short types and cannot know what to call them
			// here - and a column's declared type is the promise this adapter keeps by writing
			// NULL where a value does not match it, so the suite must not guess.
			//
			// ***`b` is a one digit number before 23c, because that engine has no boolean.***
			// The corpus already writes a boolean as 1 or 0 - better-sqlite3 refuses to bind
			// one, so it had to - and BooleanLiterals makes the clause compare against the same
			// spelling. ***23c declares a real BOOLEAN***, which is what gives that profile a
			// boolean pre-filter the older one cannot have.
			ColumnTypes: {
				b: Profile.BooleanColumnType,
				n: 'NUMBER',
				s: 'VARCHAR2(4000)',
				i: 'NUMBER(10)',
			},

			// ***How this engine spells a bound parameter.*** Oracle numbers them from one with
			// a colon, like Postgres but for a different character.
			ParameterToken: function ( Index ) { return parameter_token( Index ); },

			// ***Normalized on purpose.*** SQL_Passthrough is not advertised directly because
			// the SQL adapters do not agree about it. A surface whose contract differs between
			// its implementations is worse than none, so callers get rows, or a promise that
			// the statement ran.
			Query: async function ( Sql, Parameters ) { return ( await SQL_Passthrough( Sql, Parameters || [] ) ).results; },
			Execute: async function ( Sql ) { return await SQL_Execute( Sql ); },
		};

		//=====================================================================
		// DropStorage
		//=====================================================================


		// ***What this storage is actually talking to.*** The driver already knows: an open
		// `oracledb` connection carries the server version, so no statement is needed and none
		// is sent. ***This is also the more precise answer*** - `product_component_version`
		// reports `21.0.0.0.0` on a server which is really 21.3, and a version rounded to its
		// major would make the container naming rule unauditable.
		Storage.StorageInfo = async function ( Options )
		{
			let connection = await held_connection();
			let version = connection.oracleServerVersionString || '';
			// The catalog is the fallback, in case a driver ever stops carrying the property.
			if ( version === '' )
			{
				let answer = await SQL_Passthrough(
					`SELECT version AS server_version FROM product_component_version WHERE product LIKE 'Oracle%'`, [] );
				let row = answer.results[ 0 ] || {};
				version = row.SERVER_VERSION || '';
			}
			return jsonstor.BuildStorageInfo( Storage, {
				Product: 'Oracle',
				Version: version,
				Endpoint: `${Storage.Settings.Server}:${Storage.Settings.Port}`,
			} );
		};


		Storage.DropStorage = async function ( Options )
		{
			// ***PURGE, because Oracle has a recycle bin.*** Without it a dropped table becomes
			// a BIN$... object which still owns the name's constraints and still counts against
			// quota, and a suite which drops and recreates in a loop would accumulate them.
			await SQL_Execute_Ignoring_Missing( `DROP TABLE ${table_reference()} PURGE` );
			Storage.Catalog.initialized = false;
			await update_catalog();
			return true;
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		Storage.FlushStorage = async function ( Options )
		{
			return true;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0, Options );
			return documents.length;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function ( Document, Options = {} )
		{
			let document = await SQL_Insert( Document );
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function ( Documents, Options = {} )
		{
			let documents = [];
			for ( let index = 0; index < Documents.length; index++ )
			{
				documents.push( await SQL_Insert( Documents[ index ] ) );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function FindOne( Criteria, Projection, Options = {} )
		{
			// A read returns documents. ReturnDocuments gates what a *write* hands back, which
			// is how the built in adapters read: their FindOne, FindMany and FindMany2 never
			// consult it.
			let documents = await SQL_Query( Criteria, 1, Options );
			if ( !documents.length ) { return null; }
			if ( Projection )
			{
				documents[ 0 ] = jsongin.Project( documents[ 0 ], Projection );
			}
			return documents[ 0 ];
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function FindMany( Criteria, Projection, Options = {} )
		{
			// A read returns documents. See the note on FindOne.
			let documents = await SQL_Query( Criteria, 0, Options );
			if ( Projection )
			{
				for ( let index = 0; index < documents.length; index++ )
				{
					documents[ index ] = jsongin.Project( documents[ index ], Projection );
				}
			}
			return documents;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		Storage.FindMany2 = async function FindMany2( Criteria, Projection, Sort, MaxCount, Options = {} )
		{
			// A read returns documents. See the note on FindOne.
			let documents = await SQL_Query( Criteria, 0, Options );
			if ( Projection )
			{
				for ( let index = 0; index < documents.length; index++ )
				{
					documents[ index ] = jsongin.Project( documents[ index ], Projection );
				}
			}
			if ( Sort ) { documents = jsongin.Sort( documents, Sort ); }
			if ( MaxCount && ( MaxCount > 0 ) && ( documents.length > MaxCount ) ) { documents = documents.splice( 0, MaxCount ); }
			return documents;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		Storage.UpdateOne = async function UpdateOne( Criteria, Update, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1, Options );
			let document = null;
			if ( documents && documents.length )
			{
				document = documents[ 0 ];
			}
			if ( document )
			{
				document = jsongin.Update( document, Update );
				document = await SQL_Update( document );
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function UpdateMany( Criteria, Update, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0, Options );
			for ( let index = 0; index < documents.length; index++ )
			{
				documents[ index ] = jsongin.Update( documents[ index ], Update );
				documents[ index ] = await SQL_Update( documents[ index ] );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ReplaceOne( Criteria, Document, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1, Options );
			let document = null;
			if ( documents && documents.length )
			{
				document = documents[ 0 ];
			}
			if ( document )
			{
				if ( Document )
				{
					for ( let key in Document )
					{
						document[ key ] = Document[ key ];
					}
				}
				document = await SQL_Update( document );
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function DeleteOne( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1, Options );
			let document = null;
			if ( documents && documents.length )
			{
				let result = await SQL_Delete( documents[ 0 ] );
				if ( result )
				{
					document = documents[ 0 ];
				}
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function DeleteMany( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0, Options );
			for ( let index = 0; index < documents.length; index++ )
			{
				await SQL_Delete( documents[ index ] );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		return Storage;
	},

};


//---------------------------------------------------------------------
// ***This package is two primes and five aliases, and it is the first package in the family
// which needed more than one profile.***
//
// Oracle 18.0.0.0.0, 21.3.0.0.0 and 23.26.3.0.0 were measured against this adapter on
// 2026-09-01. ***18.0 and 21.3 answered identically*** - no BOOLEAN type, no TRUE literal, no
// IS NOT TRUE, no DROP TABLE IF EXISTS - so they are one profile. ***23.26 differs at six
// sites***, which is why a dialect here is not a set of translator options: the catalog reader,
// the column type map and the parameter binder read the same fact the translator does.
//
// ***11.2 is not a prime and cannot become one.*** node-oracledb 7 in Thin mode refuses the
// connection outright with NJS-138, so the 12c identity-column floor this family predicted was
// never reached and cannot be measured without Oracle Instant Client and Thick mode. ***The
// floor here is the driver's rather than Oracle's***, which is a different fact than the one
// `.plans/dialect-boundaries.md` had on record.
//
// See jsonx/.plans/versioned-adapters.md.

// ***What actually changes between the two, in one object each.*** A profile is read
// throughout the adapter and not only by the translator, which is the whole reason it is an
// object rather than two more entries in SQL_DIALECT.
const ORACLE_V18_PROFILE = {
	// No BOOLEAN type, no boolean literal, and no boolean expression type either - so a
	// negation needs a CASE and a boolean value never fits a column.
	HasBoolean: false,
	BooleanColumnType: 'NUMBER(1)',
};

const ORACLE_V23_PROFILE = {
	// ***Measured on 23.26.3.0.0:*** the column type is accepted, the catalog reports
	// `BOOLEAN`, `"b" = TRUE` and `"b" = 1` both run, `IS NOT TRUE` runs, the driver binds a
	// JavaScript boolean, and a row reads back as `true` and `false`.
	HasBoolean: true,
	BooleanColumnType: 'BOOLEAN',
};


// ***A prime is a floor and takes the name of the oldest version it was proven against.***
// 18.0 rather than 21.3, and 23.26 rather than 23 - a name follows a measurement here, so a
// developer on 21.3 is told the dialect is `jsonstor-oracle-v18.0` and `StorageInfo()` carries
// the server's own 21.3.0.0.0 as the third fact which makes that read as a floor.
const ORACLE_V18 = {
	AdapterName: 'jsonstor-oracle-v18.0',
	AdapterDescription: module.exports.AdapterDescription,
	GetAdapter: function ( jsonstor, Settings )
	{
		return module.exports.GetAdapter( jsonstor, Settings, ORACLE_V18_PROFILE );
	},
	Version: [ 18, 0 ],
	MeasuredTo: [ 21, 3 ],
};

const ORACLE_V23 = {
	AdapterName: 'jsonstor-oracle-v23.26',
	AdapterDescription: module.exports.AdapterDescription,
	GetAdapter: function ( jsonstor, Settings )
	{
		return module.exports.GetAdapter( jsonstor, Settings, ORACLE_V23_PROFILE );
	},
	Version: [ 23, 26 ],
	// ***Every part of it, because the comparison zero-pads.*** The server measured here
	// reports 23.26.3.0.0, and declaring [ 23, 26 ] would make this prime warn that its own
	// test server was untested - which is exactly what jsonstor-mysql did until 2026-09-01.
	MeasuredTo: [ 23, 26, 3 ],
};

module.exports.Adapters = [ ORACLE_V18, ORACLE_V23 ];

// ***The bare name is listed here rather than left on the plugin object.*** Naming it stops
// the plugin registering itself under it, so `GetStorage( 'jsonstor-oracle' )` reports the
// prime it resolved to instead of reporting itself as its own dialect.
//
// ***It resolves to the older prime, which is the safe one.*** Every 18.0 rendering runs
// correctly on 23c - the CASE negation is standard, NUMBER(1) still holds a boolean - so a
// caller who names no version gets correct answers everywhere and a slower boolean query on
// 23c. The reverse is not true, which is why the boundary check refuses it.
module.exports.Aliases = {
	'jsonstor-oracle': 'jsonstor-oracle-v18.0',
	'jsonstor-oracle-v18': 'jsonstor-oracle-v18.0',
	'jsonstor-oracle-v21': 'jsonstor-oracle-v18.0',
	'jsonstor-oracle-v21.3': 'jsonstor-oracle-v18.0',
	'jsonstor-oracle-v23': 'jsonstor-oracle-v23.26',
};
