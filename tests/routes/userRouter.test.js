/* global describe, test, expect, jest, beforeEach */

const request = require("supertest");
const express = require("express");

// 1. Mock the database with the .js extension so it catches the require call
jest.mock("../../src/database/database.js", () => ({
  Role: {
    Admin: "admin",
    Diner: "diner",
  },
  DB: {
    updateUser: jest.fn(),
    listUsers: jest.fn().mockResolvedValue([[], false]),
    deleteUser: jest.fn(),
  },
}));

// 2. Mock authRouter with a working middleware function
jest.mock("../../src/routes/authRouter.js", () => ({
  authRouter: {
    authenticateToken: jest.fn((req, res, next) => next()),
  },
  setAuth: jest.fn(),
}));

// 3. Require the router AFTER the mocks are defined
const userRouter = require("../../src/routes/userRouter.js");
const { DB } = require("../../src/database/database.js");
const { authRouter, setAuth } = require("../../src/routes/authRouter.js");

const app = express();
app.use(express.json());

// 4. Helper Middleware: Inject user from headers for testing
app.use((req, res, next) => {
  if (req.headers["x-user"]) {
    req.user = JSON.parse(req.headers["x-user"]);
    req.user.isRole = (role) => req.user.roles.some((r) => r.role === role);
  }
  next();
});

app.use("/api/user", userRouter);

describe("userRouter", () => {
  const user = JSON.stringify({
    id: 1,
    name: "User",
    roles: [{ role: "diner" }],
  });
  const adminUser = JSON.stringify({
    id: 2,
    name: "Admin",
    roles: [{ role: "admin" }],
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default behaviors
    authRouter.authenticateToken.mockImplementation((req, res, next) => next());
    setAuth.mockResolvedValue("new_token");
    DB.deleteUser.mockResolvedValue(true);
  });

  test("GET /api/user/me returns current user", async () => {
    const res = await request(app).get("/api/user/me").set("x-user", user);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
  });

  test("PUT /api/user/:userId updates user", async () => {
    const updateReq = { email: "new@test.com" };
    DB.updateUser.mockResolvedValue({ id: 1, ...updateReq });

    const res = await request(app)
      .put("/api/user/1")
      .set("x-user", user) // User updating themselves
      .send(updateReq);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("new@test.com");
    expect(res.body.token).toBe("new_token");
  });

  test("PUT /api/user/:userId fails for unauthorized update", async () => {
    const res = await request(app)
      .put("/api/user/2") // User 1 trying to update User 2
      .set("x-user", user)
      .send({});

    expect(res.status).toBe(403);
  });

  test("DELETE /api/user/:userId as admin deletes user", async () => {
    const res = await request(app)
      .delete("/api/user/1")
      .set("x-user", adminUser);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("user deleted");
    expect(DB.deleteUser).toHaveBeenCalledWith(1);
  });

  test("DELETE /api/user/:userId as non-admin fails", async () => {
    const res = await request(app).delete("/api/user/1").set("x-user", user);

    expect(res.status).toBe(403);
    expect(DB.deleteUser).not.toHaveBeenCalled();
  });

  test("list users", async () => {
    const listUsersRes = await request(app).get("/api/user");
    expect(listUsersRes.status).toBe(200);
  });
});
