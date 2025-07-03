import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const config = {
  DB_HOST: process.env.DB_HOST, // 34.93.45.15 for local, /cloudsql/INSTANCE_CONNECTION_NAME for Cloud Run
  DB_PORT: process.env.DB_PORT || 5432,
  DB_NAME: process.env.DB_NAME,
  DB_USER: process.env.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD,
 // DB_SOCKET_PATH: process.env.DB_SOCKET_PATH, // Optional, for Cloud Run socket
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'secret-key',
};

export default config; 
