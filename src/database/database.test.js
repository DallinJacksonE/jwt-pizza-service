/* global describe, test, expect, jest, beforeEach, afterEach */

const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const { DB, Role } = require("./database");
const { StatusCodeError } = require("../endpointHelper");

// Mock dependencies
jest.mock("mysql2/promise");
jest.mock("bcrypt");
jest.mock("../config", () => ({
  db: {
    connection: {
      host: "localhost",
      user: "root",
      password: "password",
      database: "pizza",
      connectTimeout: 1000,
    },
    listPerPage: 10,
  },
}));

describe("Database", () => {
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
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // --- Initialization Tests ---
  test("initializeDatabase should create database if not exists", async () => {
    // Sequence of execute calls:
    // 1. checkDatabaseExists -> returns empty array (db doesn't exist)
    // 2. addUser (insert user) -> returns { insertId: 1 }
    // 3. addUser (insert role) -> returns empty array
    mockConnection.execute
      .mockResolvedValueOnce([[]]) // checkDatabaseExists
      .mockResolvedValueOnce([{ insertId: 1 }])
      .mockResolvedValueOnce([]);
    // Mock checkDatabaseExists to return false first, then true
    const checkDatabaseExistsSpy = jest
      .spyOn(DB, "checkDatabaseExists")
      .mockResolvedValueOnce(false) // for the creation path
      .mockResolvedValue(true); // for subsequent calls

    await DB.initializeDatabase();

    expect(mysql.createConnection).toHaveBeenCalled();
    expect(mockConnection.query).toHaveBeenCalledWith(
      expect.stringContaining("CREATE DATABASE IF NOT EXISTS"),
    );
    expect(mockConnection.query).toHaveBeenCalledWith(
      expect.stringContaining("USE"),
    );
    checkDatabaseExistsSpy.mockRestore();
  });

  test("initializeDatabase should log error on connection failure", async () => {
    const error = new Error("Connection failed");
    mysql.createConnection.mockRejectedValue(error);

    await DB.initializeDatabase();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Error initializing database"),
    );
  });

  test("getConnection should return a connection", async () => {
    const conn = await DB.getConnection();
    expect(conn).toBe(mockConnection);
    expect(mysql.createConnection).toHaveBeenCalled();
  });

  // --- Menu Tests ---
  test("getMenu should return all menu items", async () => {
    const mockMenu = [{ id: 1, title: "Pizza", price: 10 }];
    mockConnection.execute.mockResolvedValue([mockMenu]);

    const result = await DB.getMenu();
    expect(result).toEqual(mockMenu);
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("SELECT * FROM menu"),
      undefined,
    );
    expect(mockConnection.end).toHaveBeenCalled();
  });

  test("addMenuItem should insert item and return it with new ID", async () => {
    const newItem = {
      title: "Burger",
      description: "Yum",
      image: "img.png",
      price: 5,
    };
    const insertResult = { insertId: 99 };
    mockConnection.execute.mockResolvedValue([insertResult]);

    const result = await DB.addMenuItem(newItem);
    expect(result).toEqual({ ...newItem, id: 99 });
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO menu"),
      expect.any(Array),
    );
  });

  // --- User Tests ---
  test("addUser should hash password and insert user", async () => {
    const newUser = {
      name: "John",
      email: "j@test.com",
      password: "pass",
      roles: [{ role: "diner" }],
    };
    const hashedPassword = "hashed_pass";
    const insertResult = { insertId: 101 };

    bcrypt.hash.mockResolvedValue(hashedPassword);
    mockConnection.execute
      .mockResolvedValueOnce([insertResult]) // Insert User
      .mockResolvedValueOnce([]); // Insert Role (Diner default)

    const result = await DB.addUser(newUser);

    expect(bcrypt.hash).toHaveBeenCalledWith("pass", 10);
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO user"),
      [newUser.name, newUser.email, hashedPassword],
    );
    expect(result.password).toBeUndefined();
    expect(result.id).toBe(101);
  });

  test("addUser should handle Franchisee role", async () => {
    const newUser = {
      name: "Owner",
      email: "o@test.com",
      password: "p",
      roles: [{ role: Role.Franchisee, object: "PizzaHut" }],
    };
    const franchiseId = 50;

    bcrypt.hash.mockResolvedValue("hash");
    mockConnection.execute
      .mockResolvedValueOnce([{ insertId: 102 }]) // Insert User
      .mockResolvedValueOnce([[{ id: franchiseId }]]) // getID for franchise
      .mockResolvedValueOnce([]); // Insert Role

    await DB.addUser(newUser);

    // Verify it looked up the franchise ID
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id FROM franchise"),
      ["PizzaHut"],
    );
    // Verify it inserted the role with the correct franchise ID
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO userRole"),
      [102, Role.Franchisee, franchiseId],
    );
  });

  test("getUser should return user with roles if credentials match", async () => {
    const user = { id: 1, email: "a@b.com", password: "hashed" };
    const roles = [{ role: "diner", objectId: 0 }];

    mockConnection.execute
      .mockResolvedValueOnce([[user]]) // Select User
      .mockResolvedValueOnce([roles]); // Select Roles

    bcrypt.compare.mockResolvedValue(true);

    const result = await DB.getUser("a@b.com", "pass");

    expect(result.email).toBe(user.email);
    expect(result.roles).toHaveLength(1);
    expect(result.password).toBeUndefined();
  });

  test("getUser should return user data without password check if password is not provided", async () => {
    const user = { id: 1, email: "a@b.com", password: "hashed" };
    const roles = [{ role: "diner", objectId: 0 }];
    mockConnection.execute
      .mockResolvedValueOnce([[user]])
      .mockResolvedValueOnce([roles]);

    const result = await DB.getUser("a@b.com"); // No password

    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(result.email).toBe(user.email);
    expect(result.password).toBeUndefined();
  });

  test("getUser should throw 404 if user not found", async () => {
    mockConnection.execute.mockResolvedValueOnce([[]]); // No user found

    await expect(DB.getUser("bad@email.com", "pass")).rejects.toThrow(
      StatusCodeError,
    );
  });

  test("getUser should throw 404 if password does not match", async () => {
    const user = { id: 1, email: "a@b.com", password: "hashed" };
    mockConnection.execute.mockResolvedValueOnce([[user]]);
    bcrypt.compare.mockResolvedValue(false); // Password doesn't match

    await expect(DB.getUser("a@b.com", "wrongpass")).rejects.toThrow(
      StatusCodeError,
    );
    expect(bcrypt.compare).toHaveBeenCalledWith("wrongpass", "hashed");
  });

  test("getUsers should return paginated and filtered users", async () => {
    const users = [{ id: 1, name: "Test User", email: "t@t.com" }];
    mockConnection.execute
      .mockResolvedValueOnce([users]) // select users
      .mockResolvedValueOnce([[]]); // select roles

    const [resultUsers, more] = await DB.getUsers(1, 5, "Test*");

    expect(mockConnection.execute).toHaveBeenCalledWith(
      "SELECT id, name, email FROM user WHERE name LIKE ? LIMIT 6 OFFSET 5",
      ["Test%"],
    );
    expect(resultUsers).toEqual(users);
    expect(more).toBe(false);
  });

  test("getUsers should indicate if there are more results", async () => {
    const users = Array(6)
      .fill({})
      .map((_, i) => ({ id: i, name: "User" })); // 6 users to exceed limit of 5
    mockConnection.execute
      .mockResolvedValueOnce([users])
      .mockResolvedValue([[]]); // select roles for all users

    const [resultUsers, more] = await DB.getUsers(0, 5, "*");

    expect(resultUsers.length).toBe(5);
    expect(more).toBe(true);
  });

  test("updateUser should update fields and return updated user", async () => {
    const updatedUserFromDB = {
      id: 1,
      name: "New Name",
      email: "new@email.com",
    };
    const rolesFromDB = [{ role: "diner", objectId: 0 }];

    bcrypt.hash.mockResolvedValue("new_hash");
    mockConnection.execute
      .mockResolvedValueOnce([{}]) // UPDATE query
      .mockResolvedValueOnce([[updatedUserFromDB]]) // SELECT user
      .mockResolvedValueOnce([rolesFromDB]); // SELECT roles

    const result = await DB.updateUser(
      1,
      "New Name",
      "new@email.com",
      "newpass",
    );

    expect(mockConnection.execute).toHaveBeenCalledWith(
      "UPDATE user SET password = ?, email = ?, name = ? WHERE id = ?",
      ["new_hash", "new@email.com", "New Name", 1],
    );
    expect(result.name).toBe("New Name");
    expect(result.email).toBe("new@email.com");
    expect(result.password).toBeUndefined();
  });

  test("updateUser should handle updating only some fields", async () => {
    const updatedUserFromDB = { id: 1, name: "Just Name" };
    mockConnection.execute
      .mockResolvedValueOnce([{}]) // UPDATE
      .mockResolvedValueOnce([[updatedUserFromDB]]) // SELECT user
      .mockResolvedValueOnce([[]]); // SELECT roles

    await DB.updateUser(1, "Just Name");

    expect(mockConnection.execute).toHaveBeenCalledWith(
      "UPDATE user SET name = ? WHERE id = ?",
      ["Just Name", 1],
    );
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });

  // --- Auth Tests ---
  test("loginUser should insert/update token", async () => {
    mockConnection.execute.mockResolvedValue([{}]);
    await DB.loginUser(1, "token.with.signature");
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO auth"),
      ["signature", 1],
    );
  });

  test("isLoggedIn should return true if token exists", async () => {
    mockConnection.execute.mockResolvedValue([[{ userId: 1 }]]); // Token found
    const result = await DB.isLoggedIn("token");
    expect(result).toBe(true);
  });

  test("logoutUser should delete token", async () => {
    mockConnection.execute.mockResolvedValue([{}]);
    await DB.logoutUser("token");
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM auth"),
      [expect.any(String)],
    );
  });

  // --- Order Tests ---
  test("getOrders should return orders with items", async () => {
    const user = { id: 1 };
    const orders = [{ id: 10, dinerId: 1 }];
    const items = [{ id: 100, menuId: 1 }];

    mockConnection.execute
      .mockResolvedValueOnce([orders]) // Get Orders
      .mockResolvedValueOnce([items]); // Get Items for Order 10

    const result = await DB.getOrders(user);
    expect(result.orders[0].items).toEqual(items);
  });

  test("getOrders should handle pagination", async () => {
    const user = { id: 1 };
    mockConnection.execute.mockResolvedValue([[]]); // No orders, just testing query

    await DB.getOrders(user, 2); // page 2

    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("LIMIT 10,10"), // offset 10, limit 10
      [user.id],
    );
  });

  test("addDinerOrder should insert order and items", async () => {
    const user = { id: 1 };
    const order = {
      franchiseId: 2,
      storeId: 3,
      items: [{ menuId: 5, description: "Pizza", price: 10 }],
    };

    mockConnection.execute
      .mockResolvedValueOnce([{ insertId: 500 }]) // Insert Order
      .mockResolvedValueOnce([[{ id: 5 }]]) // Get Menu ID
      .mockResolvedValueOnce([{}]); // Insert Item

    const result = await DB.addDinerOrder(user, order);
    expect(result.id).toBe(500);
  });

  // --- Franchise Tests ---
  test("createFranchise should create franchise and assign admins", async () => {
    const franchise = {
      name: "PizzaCorp",
      admins: [{ email: "admin@test.com" }],
    };
    const adminUser = { id: 99, name: "Admin", email: "admin@test.com" };

    mockConnection.execute
      .mockResolvedValueOnce([[adminUser]]) // Find Admin User
      .mockResolvedValueOnce([{ insertId: 10 }]) // Insert Franchise
      .mockResolvedValueOnce([{}]); // Insert User Role

    const result = await DB.createFranchise(franchise);
    expect(result.id).toBe(10);
    expect(result.admins[0].id).toBe(99);
  });

  test("createFranchise should throw if admin user not found", async () => {
    const franchise = {
      name: "PizzaCorp",
      admins: [{ email: "ghost@test.com" }],
    };
    mockConnection.execute.mockResolvedValueOnce([[]]); // User not found

    await expect(DB.createFranchise(franchise)).rejects.toThrow(
      StatusCodeError,
    );
  });

  test("getFranchises should return list", async () => {
    const franchises = [{ id: 1, name: "F1" }];
    mockConnection.execute
      .mockResolvedValueOnce([franchises]) // Select Franchises
      .mockResolvedValueOnce([[]]); // Select Stores for franchise (non-admin flow)

    const [result] = await DB.getFranchises(); // no user, so simple list
    expect(result).toEqual(franchises);
  });

  test("getFranchises should handle pagination", async () => {
    const franchises = [{ id: 1, name: "F1" }];
    mockConnection.execute
      .mockResolvedValueOnce([franchises]) // Select Franchises
      .mockResolvedValueOnce([[]]); // Select Stores for franchise

    await DB.getFranchises(null, 1, 5, "F*");

    expect(mockConnection.execute).toHaveBeenCalledWith(
      `SELECT id, name FROM franchise WHERE name LIKE ? LIMIT 6 OFFSET 5`,
      ["F%"],
    );
  });

  test("getFranchises should get full details for admin user", async () => {
    const franchises = Array.from({ length: 11 }, (_, i) => ({
      id: i,
      name: `F${i}`,
    }));
    const authUser = { isRole: (role) => role === Role.Admin };
    // Spy on getFranchise because it's called internally
    const getFranchiseSpy = jest
      .spyOn(DB, "getFranchise")
      .mockResolvedValue({});

    mockConnection.execute.mockResolvedValueOnce([franchises]); // 11 franchises returned

    const [resultFranchises, more] = await DB.getFranchises(
      authUser,
      0,
      10, // limit is 10
      "*",
    );

    expect(resultFranchises.length).toBe(10);
    expect(more).toBe(true);
    expect(getFranchiseSpy).toHaveBeenCalledTimes(10);

    getFranchiseSpy.mockRestore();
  });

  test("getUserFranchises should return franchises for a user", async () => {
    const userId = 1;
    const franchiseIds = [{ objectId: 10 }, { objectId: 20 }];
    const franchises = [
      { id: 10, name: "F10" },
      { id: 20, name: "F20" },
    ];
    const getFranchiseSpy = jest
      .spyOn(DB, "getFranchise")
      .mockResolvedValue({});

    mockConnection.execute
      .mockResolvedValueOnce([franchiseIds]) // get userRole
      .mockResolvedValueOnce([franchises]); // get franchises

    const result = await DB.getUserFranchises(userId);

    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("role='franchisee' AND userId=?"),
      [userId],
    );
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("franchise WHERE id in (?)"),
      [[10, 20]],
    );
    expect(getFranchiseSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual(franchises);

    getFranchiseSpy.mockRestore();
  });

  test("getUserFranchises should return empty array if user has no franchises", async () => {
    const userId = 1;
    mockConnection.execute.mockResolvedValueOnce([[]]); // No franchise roles

    const result = await DB.getUserFranchises(userId);

    expect(result).toEqual([]);
    expect(mockConnection.execute).toHaveBeenCalledTimes(1);
  });

  test("getFranchise should get admins and stores", async () => {
    const franchise = { id: 1 };
    const admins = [{ id: 1, name: "Admin" }];
    const stores = [{ id: 1, name: "Store" }];

    mockConnection.execute
      .mockResolvedValueOnce([admins]) // get admins
      .mockResolvedValueOnce([stores]); // get stores

    const result = await DB.getFranchise(franchise);

    expect(result.admins).toEqual(admins);
    expect(result.stores).toEqual(stores);
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("userRole AS ur JOIN user AS u"),
      [franchise.id],
    );
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("dinerOrder AS do JOIN orderItem AS oi"),
      [franchise.id],
    );
  });

  test("deleteFranchise should perform transaction", async () => {
    mockConnection.execute.mockResolvedValue([{}]);

    await DB.deleteFranchise(1);

    expect(mockConnection.beginTransaction).toHaveBeenCalled();
    expect(mockConnection.commit).toHaveBeenCalled();
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM store"),
      expect.any(Array),
    );
  });

  test("deleteFranchise should rollback on error", async () => {
    mockConnection.execute.mockRejectedValue(new Error("DB Error"));

    await expect(DB.deleteFranchise(1)).rejects.toThrow(StatusCodeError);
    expect(mockConnection.rollback).toHaveBeenCalled();
  });

  test("createStore should insert store", async () => {
    mockConnection.execute.mockResolvedValue([{ insertId: 20 }]);
    const result = await DB.createStore(1, { name: "SLC" });
    expect(result.id).toBe(20);
    expect(result.franchiseId).toBe(1);
  });

  test("deleteStore should delete store", async () => {
    mockConnection.execute.mockResolvedValue([{}]);
    await DB.deleteStore(1, 20);
    expect(mockConnection.execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM store"),
      [1, 20],
    );
  });

  // --- Helper Tests ---
  test("getID should throw error if no ID found", async () => {
    mockConnection.execute.mockResolvedValue([[]]); // No rows found
    await expect(DB.getID(mockConnection, "id", 999, "user")).rejects.toThrow(
      "No ID found",
    );
  });

  test("getTokenSignature should return signature from token", () => {
    const signature = DB.getTokenSignature("header.payload.signature");
    expect(signature).toBe("signature");
  });

  test("getTokenSignature should return empty string for invalid token", () => {
    const signature = DB.getTokenSignature("invalidtoken");
    expect(signature).toBe("");
  });
});
