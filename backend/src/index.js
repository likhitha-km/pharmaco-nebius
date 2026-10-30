import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import conversationRoutes from './routes/conversation.js';
import reportRoutes from './routes/report.js';
import drugRoutes from './routes/drug.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import adrRoutes from './routes/adr.js';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';

const app = express();
const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '127.0.0.1';

// CORS
app.use(cors({
  origin: true,
  credentials: true,
}));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
app.use('/api/', rateLimit(100, 60000));

// Auth middleware (sets req.user on all routes)
app.use(requireAuth);

// Routes
app.use('/api/conversation', conversationRoutes);
app.use('/api/report', reportRoutes);
app.use('/api/drug', drugRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/adr', adrRoutes);

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'Pharmaco API running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    endpoints: ['/api/conversation', '/api/report', '/api/drug', '/api/auth', '/api/dashboard', '/api/adr'],
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

app.listen(PORT, HOST, () => {
  console.log(`\n🌿 Pharmaco API running on http://${HOST}:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/`);
  console.log(`   Conversation: http://localhost:${PORT}/api/conversation`);
  console.log(`   Reports: http://localhost:${PORT}/api/report`);
  console.log(`   Dashboard: http://localhost:${PORT}/api/dashboard\n`);
});
