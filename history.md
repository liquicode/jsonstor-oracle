# jsonstor-oracle
[`@liquicode/jsonstor-oracle`](https://github.com/liquicode/jsonstor-oracle)


# Project History


v0.2.0 (current)
---------------------------------------------------------------------

***First release.***

The adapter for Oracle Database. Tested on Oracle 18c, 21c and 23ai.

- Built on `@liquicode/jsonstor` 0.2.0 and `@liquicode/jsongin` 0.2.0. A criteria the engine
  refuses is refused before the storage acts on it.
- A `null` criteria matches every row, and `InsertMany` refuses a value which is not an array.
- Declares Node.js `>=14.17.0` in `engines`.
