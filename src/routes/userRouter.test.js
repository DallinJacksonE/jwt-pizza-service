/* global describe, test, expect, jest, beforeEach */

const request = require("supertest");
const express = require("express");
const jwt = require("jsonwebtoken");

// 1. Mock the database with the .js extension so it catches the require call
jest.mock("../database/database.js", () => ({
  Role: {
    Admin: "admin",
    Diner: "diner",
  },
  DB: {
    updateUser: jest.fn(),
    isLoggedIn: jest.fn(),
    loginUser: jest.fn(),
    getUsers: jest.fn(),
    addUser: jest.fn(),
  },
}));

// 2. Mock config for JWT secret
jest.mock("../config.js", () => ({
  jwtSecret: "test-secret",
}));

// 3. Require the router AFTER the mocks are defined
const userRouter = require("./userRouter");
const { DB } = require("../database/database.js");
const { authRouter, setAuthUser } = require("./authRouter.js");

const app = express();
app.use(express.json());

// 4. Use the real setAuthUser middleware
app.use(setAuthUser);

// 5. Use the real authRouter to allow registration
app.use("/api/auth", authRouter);
app.use("/api/user", userRouter);

describe("userRouter", () => {
  const dinerUser = {
    id: 1,
    name: "User",
    roles: [{ role: "diner" }],
  };
  const adminUser = { id: 2, name: "Admin", roles: [{ role: "admin" }] };
  let dinerToken, adminToken;

  beforeEach(() => {
    jest.clearAllMocks();
    dinerToken = jwt.sign(dinerUser, "test-secret");
    adminToken = jwt.sign(adminUser, "test-secret");
    DB.isLoggedIn.mockResolvedValue(true);
    DB.loginUser.mockResolvedValue();
  });

  test("GET /api/user/me returns current user", async () => {
    const res = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${dinerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
  });

  test("PUT /api/user/:userId updates user", async () => {
    const updateReq = { email: "new@test.com" };
    const updatedUser = { ...dinerUser, ...updateReq };
    DB.updateUser.mockResolvedValue(updatedUser);

    const res = await request(app)
      .put("/api/user/1")
      .set("Authorization", `Bearer ${dinerToken}`) // User updating themselves
      .send(updateReq);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("new@test.com");
    expect(res.body.token).toBeDefined();
  });

  test("PUT /api/user/:userId fails for unauthorized update", async () => {
    const res = await request(app)
      .put("/api/user/2") // User 1 trying to update User 2
      .set("Authorization", `Bearer ${dinerToken}`)
      .send({});

    expect(res.status).toBe(403);
  });

  test("DELETE /api/user/:userId returns not implemented", async () => {
    const res = await request(app)
      .delete("/api/user/1")
      .set("Authorization", `Bearer ${dinerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("not implemented");
  });

  test("list users requires authentication", async () => {
    const listUsersRes = await request(app).get("/api/user");
    expect(listUsersRes.status).toBe(401);
  });

  test("list users requires admin role", async () => {
    const listUsersRes = await request(app)
      .get("/api/user")
      .set("Authorization", `Bearer ${dinerToken}`);
    expect(listUsersRes.status).toBe(403);
  });

  test("list users returns users for admin", async () => {
    const users = [dinerUser, adminUser];
    DB.getUsers.mockResolvedValue([users, false]);

    const res = await request(app)
      .get("/api/user")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual(users);
    expect(res.body.more).toBe(false);
    expect(DB.getUsers).toHaveBeenCalledWith(0, 10, "*");
  });

  test("list users handles pagination", async () => {
    const users = [dinerUser];
    DB.getUsers.mockResolvedValue([users, true]);

    const res = await request(app)
      .get("/api/user?page=1&limit=1")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual(users);
    expect(res.body.more).toBe(true);
    expect(DB.getUsers).toHaveBeenCalledWith(1, 1, "*");
  });

  test("list users handles name filter", async () => {
    const users = [adminUser];
    DB.getUsers.mockResolvedValue([users, false]);

    const res = await request(app)
      .get("/api/user?name=Admin")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual(users);
    expect(res.body.more).toBe(false);
    expect(DB.getUsers).toHaveBeenCalledWith(0, 10, "Admin");
  });

  test("list users fails for newly registered (diner) user", async () => {
    const testUser = {
      name: "pizza diner",
      email: `${randomName()}@test.com`,
      password: "a",
    };
    DB.addUser.mockResolvedValue({
      ...testUser,
      id: 99,
      roles: [{ role: "diner" }],
    });

    const [, userToken] = await registerUser(request(app), testUser);
    const listUsersRes = await request(app)
      .get("/api/user")
      .set("Authorization", "Bearer " + userToken);
    expect(listUsersRes.status).toBe(403);
  });

  async function registerUser(service, testUser) {
    const registerRes = await service.post("/api/auth").send(testUser);
    expect(registerRes.status).toBe(200);
    return [registerRes.body.user, registerRes.body.token];
  }

  function randomName() {
    return Math.random().toString(36).substring(2, 12);
  }
});
