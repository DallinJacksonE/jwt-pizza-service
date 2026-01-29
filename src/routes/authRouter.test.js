/* global describe, test, expect, jest, beforeEach */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { authRouter, setAuthUser } = require('./authRouter');
const { DB } = require('../database/database');

// Updated mock to include auth methods
jest.mock('../database/database.js', () => ({
  Role: {
    Admin: 'admin',
    Diner: 'diner',
  },
  DB: {
    getFranchises: jest.fn(),
    getUserFranchises: jest.fn(),
    createFranchise: jest.fn(),
    deleteFranchise: jest.fn(),
    createStore: jest.fn(),
    deleteStore: jest.fn(),
    getFranchise: jest.fn(),
    // Added auth methods here:
    addUser: jest.fn(),
    getUser: jest.fn(),
    loginUser: jest.fn(),
    logoutUser: jest.fn(),
    isLoggedIn: jest.fn(),
  },
}));

jest.mock('../config.js', () => ({
  jwtSecret: 'testsecret',
}));

const app = express();
app.use(express.json());
app.use(setAuthUser);
app.use('/api/auth', authRouter);

describe('authRouter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('POST /api/auth registers a user', async () => {
    const newUser = { name: 'New User', email: 'new@test.com', password: 'password' };
    const createdUser = { ...newUser, id: 1, roles: [{ role: 'diner' }] };

    DB.addUser.mockResolvedValue(createdUser);
    DB.loginUser.mockResolvedValue();

    const res = await request(app).post('/api/auth').send(newUser);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(createdUser);
    expect(res.body.token).toBeDefined();
    expect(DB.addUser).toHaveBeenCalled();
  });

  test('POST /api/auth returns 400 for missing fields', async () => {
    const res = await request(app).post('/api/auth').send({ name: 'Incomplete' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/required/);
  });

  test('PUT /api/auth logs in a user', async () => {
    const creds = { email: 'test@test.com', password: 'password' };
    const user = { id: 1, ...creds, roles: [{ role: 'diner' }] };

    DB.getUser.mockResolvedValue(user);
    DB.loginUser.mockResolvedValue();

    const res = await request(app).put('/api/auth').send(creds);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(user);
    expect(res.body.token).toBeDefined();
  });

  test('DELETE /api/auth logs out a user', async () => {
    DB.logoutUser.mockResolvedValue();
    // Create a valid token to simulate logged in state
    const token = jwt.sign({ id: 1 }, 'testsecret');
    DB.isLoggedIn.mockResolvedValue(true);

    const res = await request(app)
      .delete('/api/auth')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('logout successful');
    expect(DB.logoutUser).toHaveBeenCalledWith(token);
  });

  test('authenticateToken middleware returns 401 if not logged in', async () => {
    // We create a temporary route to test the middleware isolated
    const testApp = express();
    testApp.use(setAuthUser);
    testApp.get('/test', authRouter.authenticateToken, (req, res) => res.sendStatus(200));

    const res = await request(testApp).get('/test');
    expect(res.status).toBe(401);
  });
});
