// Vercel serverless function: every /api/* request is rewritten here (vercel.json).
// The server is compiled to server/dist by the build command.
export { default } from '../server/dist/vercel.js';
