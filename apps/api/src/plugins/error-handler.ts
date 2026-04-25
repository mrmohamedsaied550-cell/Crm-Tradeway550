import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

const errorHandler: FastifyPluginAsync = async (fastify) => {
  fastify.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: err.code,
        message: err.message,
        details: err.details,
      });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: err.flatten(),
      });
    }
    if (err.validation) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: err.message,
        details: err.validation,
      });
    }
    fastify.log.error(err);
    return reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });
};

export default fp(errorHandler, { name: 'error-handler' });
