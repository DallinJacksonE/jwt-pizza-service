/* global describe, test, expect, jest */

const { StatusCodeError, asyncHandler } = require('./endpointHelper');

describe('endpointHelper', () => {
  test('StatusCodeError should set message and statusCode', () => {
    const error = new StatusCodeError('Not Found', 404);
    expect(error.message).toBe('Not Found');
    expect(error.statusCode).toBe(404);
    expect(error).toBeInstanceOf(Error);
  });

  test('asyncHandler should catch errors and pass to next', async () => {
    const error = new Error('Async Error');
    const mockFn = jest.fn().mockRejectedValue(error);
    const mockNext = jest.fn();
    const req = {};
    const res = {};

    await asyncHandler(mockFn)(req, res, mockNext);

    expect(mockFn).toHaveBeenCalledWith(req, res, mockNext);
    expect(mockNext).toHaveBeenCalledWith(error);
  });

  test('asyncHandler should resolve successfully', async () => {
    const mockFn = jest.fn().mockResolvedValue('success');
    const mockNext = jest.fn();
    const req = {};
    const res = {};

    await asyncHandler(mockFn)(req, res, mockNext);

    expect(mockFn).toHaveBeenCalledWith(req, res, mockNext);
    expect(mockNext).not.toHaveBeenCalled();
  });
});
