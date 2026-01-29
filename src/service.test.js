/* global beforeAll, test, expect, jest */
const request = require('supertest');
const app = require('./service');
const version = require('./version.json');
const { DB } = require('./database/database'); // Import the mocked DB to configure return values

const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };

// 1. Fix path to ./database/database.js
// 2. Add auth-related methods (addUser, getUser, loginUser)
jest.mock('./database/database.js', () => ({
  Role: {
    Admin: 'admin',
    Diner: 'diner',
  },
  DB: {
    addUser: jest.fn(),
    getUser: jest.fn(),
    loginUser: jest.fn(),
    isLoggedIn: jest.fn(),
    getFranchises: jest.fn(),
    getUserFranchises: jest.fn(),
    createFranchise: jest.fn(),
    deleteFranchise: jest.fn(),
    createStore: jest.fn(),
    deleteStore: jest.fn(),
    getFranchise: jest.fn(),
  },
}));

// REMOVED: jest.mock('./authRouter.js') 
// We want the real authRouter logic to run so endpoints like POST /api/auth actually exist.

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';

  // Mock successful DB responses for registration
  DB.addUser.mockResolvedValue({ ...testUser, id: 1, roles: [{ role: 'diner' }] });
  DB.loginUser.mockResolvedValue('token');

  await request(app).post('/api/auth').send(testUser);
});

test('login', async () => {
  // Mock successful DB responses for login
  DB.getUser.mockResolvedValue({ ...testUser, id: 1, roles: [{ role: 'diner' }] });
  DB.loginUser.mockResolvedValue('token');

  const loginRes = await request(app).put('/api/auth').send(testUser);

  expect(loginRes.status).toBe(200);
  expect(loginRes.body.token).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);

  const user = { ...testUser, roles: [{ role: 'diner' }] };
  delete user.password;
  expect(loginRes.body.user).toMatchObject(user);
});

test('get home page', async () => {
  const res = await request(app).get('/');
  expect(res.status).toBe(200);
  expect(res.body.message).toBe('welcome to JWT Pizza');
  expect(res.body.version).toBe(version.version);
});

test('get docs', async () => {
  const res = await request(app).get('/api/docs');
  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('version');
  expect(res.body).toHaveProperty('endpoints');
  expect(res.body).toHaveProperty('config');
  expect(res.body.config).toHaveProperty('factory');
  expect(res.body.config).toHaveProperty('db');
});

test('unknown endpoint returns 404', async () => {
  const res = await request(app).get('/api/this-path-does-not-exist');
  expect(res.status).toBe(404);
  expect(res.body.message).toBe('unknown endpoint');
});

test('CORS headers are present', async () => {
  const res = await request(app).get('/');
  expect(res.headers['access-control-allow-origin']).toBe('*');
  expect(res.headers['access-control-allow-methods']).toBe('GET, POST, PUT, DELETE');
  expect(res.headers['access-control-allow-headers']).toBe('Content-Type, Authorization');
});
