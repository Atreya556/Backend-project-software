import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { MongoClient } from 'mongodb';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_BASE_URL = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
const port = process.env.PORT || 5000;
const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'casino_wallet_hub';
const jwtSecret = process.env.JWT_SECRET || 'change_this_secret';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendPath = path.join(__dirname, '../frontend');

const client = new MongoClient(uri);
let users;
let transactions;

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  try {
    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'Failed to get PayPal access token');
  return data.access_token;
}

function now() {
  return new Date().toISOString();
}

function cleanUser(user) {
  if (!user) return null;
  return {
    username: user.username,
    balance: user.balance,
    createdAt: user.createdAt,
    paypalEmail: user.paypalEmail || '',
    accountNumber: user.accountNumber || '',
  };
}

async function logTransaction(username, type, amount, detail, balanceAfter) {
  await transactions.insertOne({ username, type, amount, detail, balanceAfter, createdAt: now() });
}

async function getCurrentUser(req) {
  const username = req.user.username;
  const user = await users.findOne({ username }, { projection: { passwordHash: 0 } });
  if (!user) throw new Error('User not found');
  return user;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Node API running' });
});

app.get('/api/paypal/client-id', authenticateToken, (req, res) => {
  res.json({ clientId: PAYPAL_CLIENT_ID });
});

app.post('/api/paypal/create-order', authenticateToken, async (req, res) => {
  try {
    const { amount = '25.00', currency = 'USD' } = req.body;
    const value = Number(amount);

    if (!value || value <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const accessToken = await getPayPalAccessToken();
    const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            amount: {
              currency_code: currency,
              value: value.toFixed(2),
            },
          },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: data.message || 'Failed to create PayPal order' });
    }

    res.json({ id: data.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/paypal/capture-order', authenticateToken, async (req, res) => {
  try {
    const { orderID } = req.body;
    if (!orderID) return res.status(400).json({ error: 'Missing orderID' });

    const accessToken = await getPayPalAccessToken();
    const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: data.message || 'Failed to capture PayPal order' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const existing = await users.findOne({ username });
    if (existing) return res.status(400).json({ error: 'User already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      username,
      passwordHash,
      balance: 10,
      createdAt: now(),
      history: [],
      paypalEmail: '',
      accountNumber: '',
    };

    await users.insertOne(user);
    await logTransaction(username, 'starter', 10, 'Starter balance', 10);

    const token = jwt.sign({ username }, jwtSecret, { expiresIn: '1d' });
    res.status(201).json({ user: cleanUser(user), token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const user = await users.findOne({ username });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ username }, jwtSecret, { expiresIn: '1d' });
    res.json({ user: cleanUser(user), token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/user/me', authenticateToken, async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    const history = await transactions
      .find({ username: user.username }, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();

    res.json({ user: cleanUser(user), history });
  } catch (error) {
    res.status(error.message === 'User not found' ? 404 : 500).json({ error: error.message });
  }
});

app.post('/api/deposit', authenticateToken, async (req, res) => {
  try {
    const { amount, provider, orderData } = req.body;
    const value = Number(amount);
    if (!value || value <= 0) return res.status(400).json({ error: 'Valid amount is required' });

    const user = await getCurrentUser(req);
    const result = await users.findOneAndUpdate(
      { username: user.username },
      { $inc: { balance: value }, $set: { paypalEmail: user.paypalEmail || '', accountNumber: user.accountNumber || '' } },
      { returnDocument: 'after' }
    );

    const balanceAfter = result?.balance ?? result?.value?.balance;
    await logTransaction(user.username, 'deposit', value, `${provider || 'payment'} deposit${orderData?.id ? ` (${orderData.id})` : ''}`, balanceAfter);
    res.json({ message: 'Deposit successful', balance: balanceAfter, username: user.username });
  } catch (error) {
    res.status(error.message === 'User not found' ? 404 : 500).json({ error: error.message });
  }
});

app.post('/api/direct-deposit', authenticateToken, async (req, res) => {
  try {
    const { amount, accountNumber } = req.body;
    const value = Number(amount);
    if (!value || value <= 0) return res.status(400).json({ error: 'Valid amount is required' });
    if (!accountNumber) return res.status(400).json({ error: 'Account number is required' });

    const user = await getCurrentUser(req);
    const result = await users.findOneAndUpdate(
      { username: user.username },
      { $inc: { balance: value }, $set: { accountNumber } },
      { returnDocument: 'after' }
    );

    const balanceAfter = result?.balance ?? result?.value?.balance;
    await logTransaction(user.username, 'direct-deposit', value, `Direct deposit to ${accountNumber}`, balanceAfter);
    res.json({ message: 'Direct deposit successful', balance: balanceAfter, username: user.username });
  } catch (error) {
    res.status(error.message === 'User not found' ? 404 : 500).json({ error: error.message });
  }
});

app.post('/api/withdraw/account', authenticateToken, async (req, res) => {
  try {
    const { amount, accountNumber } = req.body;
    const value = Number(amount);
    if (!value || value <= 0) return res.status(400).json({ error: 'Valid amount is required' });
    if (!accountNumber) return res.status(400).json({ error: 'Account number is required' });

    const user = await getCurrentUser(req);
    if (Number(user.balance || 0) < value) return res.status(400).json({ error: 'Insufficient balance' });

    const result = await users.findOneAndUpdate(
      { username: user.username },
      { $inc: { balance: -value }, $set: { accountNumber } },
      { returnDocument: 'after' }
    );

    const balanceAfter = result?.balance ?? result?.value?.balance;
    await logTransaction(user.username, 'withdraw-account', -value, `Withdraw to account ${accountNumber}`, balanceAfter);
    res.json({ message: 'Withdraw to account successful', balance: balanceAfter, username: user.username });
  } catch (error) {
    res.status(error.message === 'User not found' ? 404 : 500).json({ error: error.message });
  }
});

app.post('/api/withdraw/paypal', authenticateToken, async (req, res) => {
  try {
    const { amount, receiver } = req.body;
    const value = Number(amount);
    if (!value || value <= 0) return res.status(400).json({ error: 'Valid amount is required' });
    if (!receiver) return res.status(400).json({ error: 'PayPal receiver email is required' });

    const user = await getCurrentUser(req);
    if (Number(user.balance || 0) < value) return res.status(400).json({ error: 'Insufficient balance' });

    const accessToken = await getPayPalAccessToken();
    const payoutBody = {
      sender_batch_header: {
        sender_batch_id: `batch_${crypto.randomUUID()}`,
        email_subject: 'You have received a payout',
        email_message: 'Your wallet withdrawal has been sent.',
      },
      items: [
        {
          recipient_type: 'EMAIL',
          amount: { value: value.toFixed(2), currency: 'USD' },
          note: 'Wallet withdrawal',
          receiver,
          sender_item_id: `item_${crypto.randomUUID()}`,
        },
      ],
    };

    const response = await fetch(`${PAYPAL_BASE_URL}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payoutBody),
    });

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.message || 'PayPal payout failed' });

    const result = await users.findOneAndUpdate(
      { username: user.username },
      { $inc: { balance: -value }, $set: { paypalEmail: receiver } },
      { returnDocument: 'after' }
    );

    const balanceAfter = result?.balance ?? result?.value?.balance;
    await logTransaction(user.username, 'withdraw-paypal', -value, `Withdraw to PayPal ${receiver}`, balanceAfter);
    res.json({
      message: 'PayPal withdrawal successful',
      balance: balanceAfter,
      username: user.username,
      payoutBatchId: data.batch_header?.payout_batch_id || '',
    });
  } catch (error) {
    res.status(error.message === 'User not found' ? 404 : 500).json({ error: error.message });
  }
});

app.post('/api/play', authenticateToken, async (req, res) => {
  try {
    const { game } = req.body;
    const games = {
      roulette: { bet: 2, outcomes: [0, 0, 4] },
      fortune: { bet: 3, outcomes: [0, 6, 9] },
      spin: { bet: 1, outcomes: [0, 0, 2] },
    };

    const config = games[game];
    if (!config) return res.status(400).json({ error: 'valid game is required' });

    const user = await getCurrentUser(req);
    if (Number(user.balance || 0) < config.bet) return res.status(400).json({ error: 'Not enough balance' });

    const reward = config.outcomes[Math.floor(Math.random() * config.outcomes.length)];
    const net = reward - config.bet;
    const result = await users.findOneAndUpdate(
      { username: user.username },
      { $inc: { balance: net } },
      { returnDocument: 'after' }
    );

    const balanceAfter = result?.balance ?? result?.value?.balance;
    await logTransaction(user.username, game, net, reward > 0 ? `Won ${reward}` : 'No payout', balanceAfter);
    res.json({ username: user.username, game, reward, net, balance: balanceAfter });
  } catch (error) {
    res.status(error.message === 'User not found' ? 404 : 500).json({ error: error.message });
  }
});

app.use('/api', (req, res, next) => {
  console.log('Unmatched API request:', req.method, req.originalUrl);
  next();
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

app.use(express.static(frontendPath));

app.get('/', (req, res) => res.sendFile(path.join(frontendPath, 'index.html')));
app.get('/wallet', (req, res) => res.sendFile(path.join(frontendPath, 'wallet.html')));
app.get('/roulette', (req, res) => res.sendFile(path.join(frontendPath, 'roulette.html')));
app.get('/fortune', (req, res) => res.sendFile(path.join(frontendPath, 'fortune.html')));
app.get('/spin', (req, res) => res.sendFile(path.join(frontendPath, 'spin.html')));
app.get('/payment', (req, res) => res.sendFile(path.join(frontendPath, 'payment.html')));
app.get('/payment.html', (req, res) => res.sendFile(path.join(frontendPath, 'payment.html')));


async function connectDb() {
  await client.connect();
  const db = client.db(dbName);
  users = db.collection('users');
  transactions = db.collection('transactions');
  await users.createIndex({ username: 1 }, { unique: true });
  console.log(`Connected to MongoDB database: ${dbName}`);
}

connectDb()
  .then(() => {
    app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
  })
  .catch((error) => {
    console.error('Database connection failed:', error);
    process.exit(1);
  });
