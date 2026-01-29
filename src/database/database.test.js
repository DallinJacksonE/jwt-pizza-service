/* global describe, test, expect, jest, beforeEach, afterEach */

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const { DB, Role } = require('./database');
const { StatusCodeError } = require('../endpointHelper');

// Mock dependencies
jest.mock('mysql2/promise');
jest.mock('bcrypt');
jest.mock('../config', () => ({
  db: {
    connection: {
      host: 'localhost',
      user: 'root',
      password: 'password',
      database: 'pizza',
      connectTimeout: 1000,
    },
    listPerPage: 10,
  },
}));

describe('Database', () => {
  let mockConnection;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Mock connection object
    mockConnection = {
      execute: jest.fn(),
      query: jest.fn(),
      end: jest.fn(),
      beginTransaction: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
    };

    // Mock mysql.createConnection to return our mock connection
    mysql.createConnection.mockResolvedValue(mockConnection);

    // Silence console logs during tests
    jest.spyOn(console, 'log').mockImplementation(() => { });
    jest.spyOn(console, 'error').mockImplementation(() => { });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // --- Initialization Tests ---
  test('initializeDatabase should create database if not exists', async () => {
    // Sequence of execute calls:
    // 1. checkDatabaseExists -> returns empty array (db doesn't exist)
    // 2. addUser (insert user) -> returns { insertId: 1 }
    // 3. addUser (insert role) -> returns empty array
    mockConnection.execute
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([]);

    await DB.initializeDatabase();

    expect(mysql.createConnection).toHaveBeenCalled();
    expect(mockConnection.query).toHaveBeenCalledWith(expect.stringContaining('CREATE DATABASE IF NOT EXISTS'));
    expect(mockConnection.query).toHaveBeenCalledWith(expect.stringContaining('USE'));
  });

  test('getConnection should return a connection', async () => {
    const conn = await DB.getConnection();
    expect(conn).toBe(mockConnection);
    expect(mysql.createConnection).toHaveBeenCalled();
  });

  // --- Menu Tests ---
  test('getMenu should return all menu items', async () => {
    const mockMenu = [{ id: 1, title: 'Pizza', price: 10 }];
    mockConnection.execute.mockResolvedValue([mockMenu]);

    const result = await DB.getMenu();
    expect(result).toEqual(mockMenu);
    expect(mockConnection.execute).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM menu'), undefined);
    expect(mockConnection.end).toHaveBeenCalled();
  });

  test('addMenuItem should insert item and return it with new ID', async () => {
    const newItem = { title: 'Burger', description: 'Yum', image: 'img.png', price: 5 };
    const insertResult = { insertId: 99 };
    mockConnection.execute.mockResolvedValue([insertResult]);

    const result = await DB.addMenuItem(newItem);
    expect(result).toEqual({ ...newItem, id: 99 });
    expect(mockConnection.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO menu'), expect.any(Array));
  });

  // --- User Tests ---
  test('addUser should hash password and insert user', async () => {
    const newUser = { name: 'John', email: 'j@test.com', password: 'pass', roles: [{ role: 'diner' }] };
    const hashedPassword = 'hashed_pass';
    const insertResult = { insertId: 101 };

    bcrypt.hash.mockResolvedValue(hashedPassword);
    mockConnection.execute
      .mockResolvedValueOnce([insertResult]) // Insert User
      .mockResolvedValueOnce([]); // Insert Role (Diner default)

    const result = await DB.addUser(newUser);

    expect(bcrypt.hash).toHaveBeenCalledWith('pass', 10);
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user'),
      [newUser.name, newUser.email, hashedPassword]
    );
    expect(result.password).toBeUndefined();
    expect(result.id).toBe(101);
  });

  test('addUser should handle Franchisee role', async () => {
    const newUser = { name: 'Owner', email: 'o@test.com', password: 'p', roles: [{ role: Role.Franchisee, object: 'PizzaHut' }] };
    const franchiseId = 50;

    bcrypt.hash.mockResolvedValue('hash');
    mockConnection.execute
      .mockResolvedValueOnce([{ insertId: 102 }]) // Insert User
      .mockResolvedValueOnce([[{ id: franchiseId }]]) // getID for franchise
      .mockResolvedValueOnce([]); // Insert Role

    await DB.addUser(newUser);

    // Verify it looked up the franchise ID
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id FROM franchise'),
      ['PizzaHut']
    );
    // Verify it inserted the role with the correct franchise ID
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO userRole'),
      [102, Role.Franchisee, franchiseId]
    );
  });

  test('getUser should return user with roles if credentials match', async () => {
    const user = { id: 1, email: 'a@b.com', password: 'hashed' };
    const roles = [{ role: 'diner', objectId: 0 }];

    mockConnection.execute
      .mockResolvedValueOnce([[user]]) // Select User
      .mockResolvedValueOnce([roles]); // Select Roles

    bcrypt.compare.mockResolvedValue(true);

    const result = await DB.getUser('a@b.com', 'pass');

    expect(result.email).toBe(user.email);
    expect(result.roles).toHaveLength(1);
    expect(result.password).toBeUndefined();
  });

  test('getUser should throw 404 if user not found', async () => {
    mockConnection.execute.mockResolvedValueOnce([[]]); // No user found

    await expect(DB.getUser('bad@email.com', 'pass')).rejects.toThrow(StatusCodeError);
  });

  test('updateUser should update fields and return updated user', async () => {
    // Mock getUser inside updateUser
    const existingUser = { id: 1, email: 'new@email.com' };
    // We need to spy on getUser because it's a method on the class instance
    jest.spyOn(DB, 'getUser').mockResolvedValue(existingUser);

    bcrypt.hash.mockResolvedValue('new_hash');
    mockConnection.execute.mockResolvedValue([{}]); // Update query

    const result = await DB.updateUser(1, 'New Name', 'new@email.com', 'newpass');

    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE user SET'),
      undefined // params are injected directly into string in implementation
    );
    expect(result).toEqual(existingUser);
  });

  // --- Auth Tests ---
  test('loginUser should insert/update token', async () => {
    mockConnection.execute.mockResolvedValue([{}]);
    await DB.loginUser(1, 'token');
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO auth'),
      expect.any(Array)
    );
  });

  test('isLoggedIn should return true if token exists', async () => {
    mockConnection.execute.mockResolvedValue([[{ userId: 1 }]]);
    const result = await DB.isLoggedIn('token');
    expect(result).toBe(true);
  });

  test('logoutUser should delete token', async () => {
    mockConnection.execute.mockResolvedValue([{}]);
    await DB.logoutUser('token');
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM auth'),
      expect.any(Array)
    );
  });

  // --- Order Tests ---
  test('getOrders should return orders with items', async () => {
    const user = { id: 1 };
    const orders = [{ id: 10, dinerId: 1 }];
    const items = [{ id: 100, menuId: 1 }];

    mockConnection.execute
      .mockResolvedValueOnce([orders]) // Get Orders
      .mockResolvedValueOnce([items]); // Get Items for Order 10

    const result = await DB.getOrders(user);
    expect(result.orders[0].items).toEqual(items);
  });

  test('addDinerOrder should insert order and items', async () => {
    const user = { id: 1 };
    const order = { franchiseId: 2, storeId: 3, items: [{ menuId: 5, description: 'Pizza', price: 10 }] };

    mockConnection.execute
      .mockResolvedValueOnce([{ insertId: 500 }]) // Insert Order
      .mockResolvedValueOnce([[{ id: 5 }]]) // Get Menu ID
      .mockResolvedValueOnce([{}]); // Insert Item

    const result = await DB.addDinerOrder(user, order);
    expect(result.id).toBe(500);
  });

  // --- Franchise Tests ---
  test('createFranchise should create franchise and assign admins', async () => {
    const franchise = { name: 'PizzaCorp', admins: [{ email: 'admin@test.com' }] };
    const adminUser = { id: 99, name: 'Admin', email: 'admin@test.com' };

    mockConnection.execute
      .mockResolvedValueOnce([[adminUser]]) // Find Admin User
      .mockResolvedValueOnce([{ insertId: 10 }]) // Insert Franchise
      .mockResolvedValueOnce([{}]); // Insert User Role

    const result = await DB.createFranchise(franchise);
    expect(result.id).toBe(10);
    expect(result.admins[0].id).toBe(99);
  });

  test('getFranchises should return list', async () => {
    const franchises = [{ id: 1, name: 'F1' }];
    mockConnection.execute
      .mockResolvedValueOnce([franchises]) // Select Franchises
      .mockResolvedValueOnce([[]]); // Select Stores for franchise (non-admin flow)

    const result = await DB.getFranchises(); // no user, so simple list
    expect(result[0]).toEqual(franchises);
  });

  test('deleteFranchise should perform transaction', async () => {
    mockConnection.execute.mockResolvedValue([{}]);

    await DB.deleteFranchise(1);

    expect(mockConnection.beginTransaction).toHaveBeenCalled();
    expect(mockConnection.commit).toHaveBeenCalled();
    expect(mockConnection.execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM store'), expect.any(Array));
  });

  test('deleteFranchise should rollback on error', async () => {
    mockConnection.execute.mockRejectedValue(new Error('DB Error'));

    await expect(DB.deleteFranchise(1)).rejects.toThrow(StatusCodeError);
    expect(mockConnection.rollback).toHaveBeenCalled();
  });

  test('createStore should insert store', async () => {
    mockConnection.execute.mockResolvedValue([{ insertId: 20 }]);
    const result = await DB.createStore(1, { name: 'SLC' });
    expect(result.id).toBe(20);
    expect(result.franchiseId).toBe(1);
  });

  test('deleteStore should delete store', async () => {
    mockConnection.execute.mockResolvedValue([{}]);
    await DB.deleteStore(1, 20);
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM store'),
      [1, 20]
    );
  });
});
