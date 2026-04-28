/**
 * Zod-backed validation pipe for NestJS.
 *
 * Re-exports the pipe from `nestjs-zod` so the rest of the codebase can import
 * a stable path even if we swap the underlying adapter later.
 *
 * Usage (from C9 onward):
 *   import { createZodDto } from 'nestjs-zod';
 *   class LoginDto extends createZodDto(loginSchema) {}
 *   @Post('login') login(@Body() body: LoginDto) { ... }
 */
export { ZodValidationPipe } from 'nestjs-zod';
export { createZodDto } from 'nestjs-zod';
