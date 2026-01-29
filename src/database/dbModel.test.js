/* global describe, test, expect */
const { tableCreateStatements } = require('./dbModel');

describe('dbModel', () => {
  test('should export an array of table creation statements', () => {
    expect(Array.isArray(tableCreateStatements)).toBe(true);
    expect(tableCreateStatements.length).toBeGreaterThan(0);
  });

  test('statements should be CREATE TABLE statements', () => {
    tableCreateStatements.forEach((statement) => {
      expect(typeof statement).toBe('string');
      // Basic check to ensure they start with the expected SQL command
      expect(statement.trim().toUpperCase()).toMatch(/^CREATE TABLE IF NOT EXISTS/);
    });
  });

  test('should include necessary tables', () => {
    const tableNames = [
      'auth',
      'user',
      'menu',
      'franchise',
      'store',
      'userRole',
      'dinerOrder',
      'orderItem'
    ];

    tableNames.forEach(tableName => {
      const found = tableCreateStatements.some(stmt =>
        stmt.includes(`CREATE TABLE IF NOT EXISTS ${tableName}`)
      );
      expect(found).toBe(true);
    });
  });
});
