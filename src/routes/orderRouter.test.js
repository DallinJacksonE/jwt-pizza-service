/* global describe, test, expect, jest, beforeEach */

const request = require('supertest');
const express = require('express');

// 1. Mock the database with explicit .js extension
jest.mock('../database/database.js', () => ({
  Role: {
    Admin: 'admin',
    Diner: 'diner',
  },
  DB: {
    getMenu: jest.fn(),
    addMenuItem: jest.fn(),
    getOrders: jest.fn(),
    addDinerOrder: jest.fn(),
  },
}));

// 2. Mock authRouter with working middleware
jest.mock('./authRouter.js', () => ({
  authRouter: {
    authenticateToken: jest.fn((req, res, next) => next()),
  },
}));

// 3. Mock config
jest.mock('../config.js', () => ({
  factory: { url: 'http://factory', apiKey: 'key' },
}));

global.fetch = jest.fn();

// 4. Require modules AFTER mocks
const orderRouter = require('./orderRouter');
const { DB, Role } = require('../database/database.js');
const { authRouter } = require('./authRouter.js');

const app = express();
app.use(express.json());

// Mock Middleware Setup: Inject user based on headers
app.use((req, res, next) => {
  if (req.headers['x-user']) {
    req.user = JSON.parse(req.headers['x-user']);
    req.user.isRole = (role) => req.user.roles.some((r) => r.role === role);
  }
  next();
});

app.use('/api/order', orderRouter);

describe('orderRouter', () => {
  const adminUser = JSON.stringify({ id: 1, roles: [{ role: 'admin' }] });
  const dinerUser = JSON.stringify({ id: 2, name: 'Diner', email: 'd@t.com', roles: [{ role: 'diner' }] });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset auth behavior to succeed by default
    authRouter.authenticateToken.mockImplementation((req, res, next) => next());
  });

  test('GET /api/order/menu returns menu', async () => {
    const menu = [{ title: 'Pizza' }];
    DB.getMenu.mockResolvedValue(menu);

    const res = await request(app).get('/api/order/menu');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(menu);
  });

  test('PUT /api/order/menu adds item (Admin)', async () => {
    DB.addMenuItem.mockResolvedValue();
    DB.getMenu.mockResolvedValue([{ title: 'New Pizza' }]);

    const res = await request(app)
      .put('/api/order/menu')
      .set('x-user', adminUser)
      .send({ title: 'New Pizza' });

    expect(res.status).toBe(200);
    expect(DB.addMenuItem).toHaveBeenCalled();
  });

  test('GET /api/order returns orders', async () => {
    const orders = [{ id: 1 }];
    DB.getOrders.mockResolvedValue(orders);

    const res = await request(app)
      .get('/api/order')
      .set('x-user', dinerUser);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(orders);
  });

  test('POST /api/order creates order and calls factory', async () => {
    const orderReq = { items: [] };
    const order = { id: 1, ...orderReq };
    DB.addDinerOrder.mockResolvedValue(order);

    // Mock successful factory response
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ reportUrl: 'http://report', jwt: 'factory_jwt' }),
    });

    const res = await request(app)
      .post('/api/order')
      .set('x-user', dinerUser)
      .send(orderReq);

    expect(res.status).toBe(200);
    expect(res.body.order).toEqual(order);
    expect(res.body.followLinkToEndChaos).toBe('http://report');
    expect(global.fetch).toHaveBeenCalled();
  });

  test('POST /api/order returns 500 if factory fails', async () => {
    DB.addDinerOrder.mockResolvedValue({ id: 1 });

    // Mock failed factory response
    global.fetch.mockResolvedValue({
      ok: false,
      json: async () => ({ reportUrl: 'http://report' }),
    });

    const res = await request(app)
      .post('/api/order')
      .set('x-user', dinerUser)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/Failed to fulfill/);
  });
});
