/* global describe, test, expect, jest, beforeEach */

const request = require('supertest');
const express = require('express');
const franchiseRouter = require('./franchiseRouter');
const { DB, Role } = require('../database/database');
const { authRouter } = require('./authRouter');

// Explicitly mock the database with the .js extension to match source requirements
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
  },
}));

jest.mock('./authRouter.js', () => ({
  authRouter: {
    authenticateToken: jest.fn((req, res, next) => next()), // Default: call next()
  },
}));

const app = express();
app.use(express.json());

// Mock Middleware Setup: Inject user based on headers for testing purposes
app.use((req, res, next) => {
  req.user = req.headers['x-user'] ? JSON.parse(req.headers['x-user']) : null;
  if (req.user) {
    req.user.isRole = (role) => req.user.roles.some(r => r.role === role);
  }
  next();
});

// Mock authenticateToken to pass if user exists
authRouter.authenticateToken = (req, res, next) => {
  if (!req.user) return res.status(401).send({ message: 'unauthorized' });
  next();
};

app.use('/api/franchise', franchiseRouter);

describe('franchiseRouter', () => {
  const adminUser = JSON.stringify({ id: 1, roles: [{ role: Role.Admin }] });
  const dinerUser = JSON.stringify({ id: 2, roles: [{ role: Role.Diner }] });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('GET /api/franchise returns franchises', async () => {
    const mockFranchises = [{ id: 1, name: 'PizzaPlace' }];
    DB.getFranchises.mockResolvedValue([mockFranchises, false]);

    const res = await request(app).get('/api/franchise');
    expect(res.status).toBe(200);
    expect(res.body.franchises).toEqual(mockFranchises);
  });

  test('GET /api/franchise/:userId returns user franchises', async () => {
    const mockFranchises = [{ id: 1, name: 'MyFranchise' }];
    DB.getUserFranchises.mockResolvedValue(mockFranchises);

    // Requesting own franchises
    const res = await request(app)
      .get('/api/franchise/2')
      .set('x-user', dinerUser);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockFranchises);
  });

  test('POST /api/franchise creates franchise (Admin only)', async () => {
    const newFranchise = { name: 'NewChain', admins: [] };
    DB.createFranchise.mockResolvedValue(newFranchise);

    const res = await request(app)
      .post('/api/franchise')
      .set('x-user', adminUser)
      .send(newFranchise);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(newFranchise);
  });

  test('POST /api/franchise fails for non-admin', async () => {
    const res = await request(app)
      .post('/api/franchise')
      .set('x-user', dinerUser)
      .send({ name: 'Fail' });

    expect(res.status).toBe(403);
  });

  test('DELETE /api/franchise/:franchiseId deletes franchise', async () => {
    DB.deleteFranchise.mockResolvedValue();

    const res = await request(app)
      .delete('/api/franchise/1'); // Note: The route doesn't explicitly require auth in code provided, but likely should. Following code strictly.

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('franchise deleted');
  });

  test('POST /api/franchise/:id/store creates store', async () => {
    const franchise = { id: 1, admins: [{ id: 1 }] }; // Admin matches
    DB.getFranchise.mockResolvedValue(franchise);
    DB.createStore.mockResolvedValue({ id: 1, name: 'Store' });

    const res = await request(app)
      .post('/api/franchise/1/store')
      .set('x-user', adminUser)
      .send({ name: 'Store' });

    expect(res.status).toBe(200);
  });

  test('DELETE /api/franchise/:id/store/:storeId deletes store', async () => {
    const franchise = { id: 1, admins: [{ id: 1 }] };
    DB.getFranchise.mockResolvedValue(franchise);
    DB.deleteStore.mockResolvedValue();

    const res = await request(app)
      .delete('/api/franchise/1/store/1')
      .set('x-user', adminUser);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('store deleted');
  });
});
