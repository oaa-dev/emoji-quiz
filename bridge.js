require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');

const PORT = parseInt(process.env.PORT, 10) || 8080;

// ── Game config ──────────────────────────────────────────────────────────
const ROUND_TIME = 600;          // 10 minutes per round (auto-advance)
const RESULTS_DISPLAY_TIME = 6000; // ms to show results before next puzzle
const HINT_INTERVAL = 300;       // 5 minutes before first hint
const BASE_SCORE = 100;

// ── Logger ───────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().slice(11, 19); }
const LOG = {
  info:  (msg) => console.log(`\x1b[32m[EMOJI ${ts()}]\x1b[0m ${msg}`),
  warn:  (msg) => console.log(`\x1b[33m[EMOJI ${ts()}]\x1b[0m ${msg}`),
  error: (msg) => console.log(`\x1b[31m[EMOJI ${ts()}]\x1b[0m ${msg}`),
  chat:  (msg) => console.log(`\x1b[35m[CHAT ${ts()}]\x1b[0m ${msg}`),
};

// ── Emoji Puzzle Pool (loaded from external file) ────────────────────────
const PUZZLES = JSON.parse(fs.readFileSync(path.join(__dirname, 'puzzles.json'), 'utf8'));

let puzzlePool = [];

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickPuzzle() {
  if (puzzlePool.length === 0) {
    puzzlePool = shuffleArray([...PUZZLES]);
  }
  return puzzlePool.shift();
}

// ── Answer matching ──────────────────────────────────────────────────────
function normalize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\b(the|a|an)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkAnswer(guess, puzzle) {
  const norm = normalize(guess);
  if (!norm) return false;
  return puzzle.accepts.some(a => normalize(a) === norm);
}

// ── HTTP server ──────────────────────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/overlay.html') {
    fs.readFile(path.join(__dirname, 'overlay.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error loading overlay'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // Serve static files: manifest.json, sw.js, icons/*
  const safePath = path.normalize(url).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(__dirname, safePath);

  // Only serve known static files
  if (['/manifest.json', '/sw.js'].includes(url) || url.startsWith('/icons/')) {
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server ─────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

// ── TikTok connection ────────────────────────────────────────────────────
let tiktokConnection = null;
let connectedUsername = null;

async function connectTikTok(username) {
  if (tiktokConnection) {
    try { await tiktokConnection.disconnect(); } catch (_) {}
    tiktokConnection = null;
  }

  LOG.info(`Connecting to TikTok Live: @${username}`);
  tiktokConnection = new WebcastPushConnection(username, {
    fetchRoomInfoOnConnect: true,
    requestOptions: { timeout: 30000 },
  });

  try {
    const state = await tiktokConnection.connect();
    connectedUsername = username;
    LOG.info(`Connected to @${username} — Room ID: ${state.roomId}`);
    broadcast({ type: 'status', status: 'connected', username });

    tiktokConnection.on('chat', (data) => {
      const uid = data.uniqueId || data.nickname || 'anonymous';
      const nickname = data.nickname || data.uniqueId || 'anonymous';
      const profilePic = data.profilePictureUrl || '';
      const comment = (data.comment || '').trim();

      LOG.chat(`${uid}: ${comment}`);
      processGuess(uid, nickname, profilePic, comment);
    });

    tiktokConnection.on('gift', (data) => {
      LOG.info(`Gift from ${data.uniqueId}: ${data.giftName}`);
      broadcast({
        type: 'gift',
        username: data.uniqueId || 'anonymous',
        nickname: data.nickname || 'anonymous',
        giftName: data.giftName,
      });
    });

    tiktokConnection.on('member', (data) => {
      const nickname = data.nickname || data.uniqueId || 'someone';
      const profilePic = data.profilePictureUrl || '';
      LOG.info(`${nickname} joined the live`);
      broadcast({ type: 'join', nickname, profilePic });
    });

    tiktokConnection.on('roomUser', (data) => {
      broadcast({ type: 'viewerCount', count: data.viewerCount });
    });

    tiktokConnection.on('streamEnd', () => {
      LOG.warn('Stream ended');
      broadcast({ type: 'status', status: 'disconnected', reason: 'stream_ended' });
      tiktokConnection = null;
      connectedUsername = null;
    });

    tiktokConnection.on('error', (err) => LOG.error(`TikTok error: ${err.message}`));

    tiktokConnection.on('disconnected', () => {
      LOG.warn('Disconnected from TikTok');
      broadcast({ type: 'status', status: 'disconnected' });
      tiktokConnection = null;
      connectedUsername = null;
    });
  } catch (err) {
    const errMsg = err?.message || err?.toString() || String(err);
    LOG.error(`Failed to connect: ${errMsg}`);
    tiktokConnection = null;

    // Auto-retry up to 3 times for timeout errors
    if (!connectTikTok._retries) connectTikTok._retries = 0;
    if (errMsg.includes('timeout') && connectTikTok._retries < 3) {
      connectTikTok._retries++;
      LOG.warn(`Retrying connection (${connectTikTok._retries}/3) in 5s...`);
      broadcast({ type: 'status', status: 'error', message: `Retrying (${connectTikTok._retries}/3)...` });
      setTimeout(() => connectTikTok(username), 5000);
    } else {
      connectTikTok._retries = 0;
      broadcast({ type: 'status', status: 'error', message: errMsg });
    }
  }
}

async function disconnectTikTok() {
  if (tiktokConnection) {
    try { await tiktokConnection.disconnect(); } catch (_) {}
    tiktokConnection = null;
    connectedUsername = null;
    LOG.info('Disconnected from TikTok');
    broadcast({ type: 'status', status: 'disconnected' });
  }
}

// ── Game state ───────────────────────────────────────────────────────────
let gameState = 'idle';         // idle | puzzle | results
let currentPuzzle = null;
let puzzleNumber = 0;
let roundStartTime = 0;
let correctCount = 0;           // how many got it right this round
let roundTimer = null;
let resultsTimer = null;
let hintTimer = null;
let revealedIndices = new Set(); // which letters of the answer are revealed

/** @type {Array<{username: string, nickname: string, profilePic: string, guess: string, correct: boolean, timestamp: number}>} */
let recentGuesses = [];

/** @type {Map<string, {score: number, correct: number, streak: number, bestStreak: number, nickname: string, profilePic: string}>} */
let leaderboard = new Map();

/** @type {Set<string>} */
let roundCorrectUsers = new Set();

function processGuess(username, nickname, profilePic, guess) {
  if (gameState !== 'puzzle') return;
  if (!guess || guess.length > 100) return;

  // Chat commands
  const lower = guess.toLowerCase().trim();
  if (lower === 'skip') {
    LOG.info(`Skip requested by ${username}`);
    clearTimeout(roundTimer);
    clearTimeout(resultsTimer);
    clearInterval(hintTimer);
    broadcast({
      type: 'reveal',
      answer: currentPuzzle.answer,
      emojis: currentPuzzle.emojis,
      skippedBy: nickname || username,
    });
    resultsTimer = setTimeout(() => startRound(), 3000);
    return;
  }
  if (lower === 'hint') {
    LOG.info(`Hint requested by ${username}`);
    revealHint();
    return;
  }

  // Already got it right this round — ignore
  if (roundCorrectUsers.has(username)) return;

  const isCorrect = checkAnswer(guess, currentPuzzle);
  const elapsed = (Date.now() - roundStartTime) / 1000;

  // Update leaderboard entry
  let entry = leaderboard.get(username);
  if (!entry) {
    entry = { score: 0, correct: 0, streak: 0, bestStreak: 0, nickname, profilePic };
    leaderboard.set(username, entry);
  }
  if (nickname) entry.nickname = nickname;
  if (profilePic) entry.profilePic = profilePic;

  let scoreAwarded = 0;

  if (isCorrect) {
    correctCount++;
    roundCorrectUsers.add(username);

    // Base score
    scoreAwarded = BASE_SCORE;

    // Speed bonus: linear decay over ROUND_TIME (max +100)
    const speedBonus = Math.round(100 * Math.max(0, 1 - elapsed / ROUND_TIME));
    scoreAwarded += speedBonus;

    // Position bonus
    if (correctCount === 1) scoreAwarded += 50;
    else if (correctCount === 2) scoreAwarded += 25;
    else if (correctCount === 3) scoreAwarded += 10;

    // Streak
    entry.streak++;
    if (entry.streak > entry.bestStreak) entry.bestStreak = entry.streak;

    // Streak multiplier (3+ consecutive correct)
    if (entry.streak >= 3) {
      scoreAwarded = Math.round(scoreAwarded * 1.5);
    }

    entry.correct++;
    entry.score += scoreAwarded;

    LOG.info(`✓ ${username} got it! "${guess}" (+${scoreAwarded} pts, #${correctCount})`);
  }

  // Add to recent guesses
  recentGuesses.push({
    username, nickname, profilePic, guess,
    correct: isCorrect, timestamp: Date.now(),
  });
  // Keep last 20
  if (recentGuesses.length > 20) recentGuesses.shift();

  // Broadcast the guess
  broadcast({
    type: 'guess',
    username, nickname, profilePic, guess,
    correct: isCorrect,
    score: scoreAwarded,
    position: isCorrect ? correctCount : 0,
    streak: isCorrect ? entry.streak : 0,
  });

  // First correct answer — announce winner and advance immediately
  if (isCorrect && correctCount === 1) {
    broadcast({
      type: 'winner',
      username, nickname, profilePic,
      answer: currentPuzzle.answer,
      score: scoreAwarded,
    });
    clearTimeout(roundTimer);
    clearInterval(hintTimer);
    // Reset streaks for users who didn't answer correctly
    for (const [u, e] of leaderboard) {
      if (!roundCorrectUsers.has(u)) e.streak = 0;
    }
    const lbArray = [...leaderboard.entries()]
      .map(([u, e]) => ({ username: u, ...e }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    broadcast({ type: 'leaderboardUpdate', leaderboard: lbArray });
    // Streak notifications
    for (const [u, e] of leaderboard) {
      if (e.streak >= 3) broadcast({ type: 'streak', username: u, nickname: e.nickname, streak: e.streak });
    }
    // Next puzzle after brief confetti moment
    roundTimer = setTimeout(() => startRound(), 2000);
  }
}

function getHintBlanks() {
  const answer = currentPuzzle.answer;
  let blanks = '';
  for (let i = 0; i < answer.length; i++) {
    if (answer[i] === ' ') blanks += '  ';
    else if (revealedIndices.has(i)) blanks += answer[i].toUpperCase();
    else blanks += '_ ';
  }
  return blanks.trim();
}

function revealHint() {
  if (gameState !== 'puzzle' || !currentPuzzle) return;
  const answer = currentPuzzle.answer;
  // Find unrevealed letter indices (not spaces)
  const hidden = [];
  for (let i = 0; i < answer.length; i++) {
    if (answer[i] !== ' ' && !revealedIndices.has(i)) hidden.push(i);
  }
  if (hidden.length <= 1) return; // Don't reveal the last letter
  // Reveal a random one
  const idx = hidden[Math.floor(Math.random() * hidden.length)];
  revealedIndices.add(idx);

  broadcast({
    type: 'hint',
    blanks: getHintBlanks(),
    revealedCount: revealedIndices.size,
    totalLetters: answer.replace(/\s/g, '').length,
  });
  LOG.info(`Hint revealed: ${getHintBlanks()}`);
}

function endRound() {
  clearTimeout(roundTimer);
  clearInterval(hintTimer);
  roundTimer = null;
  hintTimer = null;

  // Reset streaks for users who didn't answer correctly
  for (const [username, entry] of leaderboard) {
    if (!roundCorrectUsers.has(username)) {
      entry.streak = 0;
    }
  }

  LOG.info(`Round over (timeout): Answer was "${currentPuzzle.answer}"`);

  // Reveal answer on timeout
  broadcast({
    type: 'reveal',
    answer: currentPuzzle.answer,
    emojis: currentPuzzle.emojis,
  });

  // Next puzzle after brief reveal
  resultsTimer = setTimeout(() => startRound(), 3000);
}

function startRound() {
  clearTimeout(resultsTimer);
  clearTimeout(roundTimer);
  clearInterval(hintTimer);
  resultsTimer = null;

  const puzzle = pickPuzzle();
  currentPuzzle = puzzle;
  puzzleNumber++;
  correctCount = 0;
  roundCorrectUsers = new Set();
  recentGuesses = [];
  revealedIndices = new Set();
  roundStartTime = Date.now();
  gameState = 'puzzle';

  LOG.info(`Puzzle #${puzzleNumber}: ${puzzle.emojis} = "${puzzle.answer}" [${puzzle.category}/${puzzle.difficulty}]`);

  broadcast({
    type: 'puzzle',
    puzzleNumber,
    emojis: puzzle.emojis,
    category: puzzle.category,
    difficulty: puzzle.difficulty,
    blanks: getHintBlanks(),
    letterCount: puzzle.answer.replace(/\s/g, '').length,
    wordCount: puzzle.answer.split(' ').length,
  });

  // Timer to end round
  roundTimer = setTimeout(() => endRound(), ROUND_TIME * 1000);

  // Auto-hint every HINT_INTERVAL seconds
  hintTimer = setInterval(() => revealHint(), HINT_INTERVAL * 1000);
}

function resetGame() {
  clearTimeout(resultsTimer);
  clearTimeout(roundTimer);
  clearInterval(hintTimer);
  resultsTimer = null;
  roundTimer = null;
  hintTimer = null;
  leaderboard = new Map();
  puzzleNumber = 0;
  correctCount = 0;
  recentGuesses = [];
  currentPuzzle = null;
  roundCorrectUsers = new Set();
  revealedIndices = new Set();
  gameState = 'idle';
  puzzlePool = [];
  broadcast({ type: 'newGame' });
}

// ── WebSocket message handling ───────────────────────────────────────────
wss.on('connection', (ws) => {
  LOG.info('Overlay client connected');

  // Build leaderboard
  const lbArray = [...leaderboard.entries()]
    .map(([username, e]) => ({ username, ...e }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  const elapsedTime = gameState === 'puzzle'
    ? Math.floor((Date.now() - roundStartTime) / 1000)
    : 0;

  ws.send(JSON.stringify({
    type: 'init',
    connected: !!tiktokConnection,
    username: connectedUsername,
    gameState,
    puzzleNumber,
    currentPuzzle: gameState === 'puzzle' && currentPuzzle ? {
      emojis: currentPuzzle.emojis,
      category: currentPuzzle.category,
      difficulty: currentPuzzle.difficulty,
      blanks: getHintBlanks(),
      letterCount: currentPuzzle.answer.replace(/\s/g, '').length,
      wordCount: currentPuzzle.answer.split(' ').length,
    } : null,
    elapsedTime,
    recentGuesses: recentGuesses.slice(-8),
    leaderboard: lbArray,
  }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg?.action) return;

    switch (msg.action) {
      case 'connect':
        if (typeof msg.username === 'string' && msg.username.trim()) {
          await connectTikTok(msg.username.trim());
        }
        break;
      case 'disconnect':
        await disconnectTikTok();
        break;
      case 'newGame':
        resetGame();
        startRound();
        break;
      case 'skip':
        clearTimeout(roundTimer);
        clearTimeout(resultsTimer);
        clearInterval(hintTimer);
        startRound();
        break;
      case 'hint':
        revealHint();
        break;
      case 'guess':
        // Test guess from overlay
        if (typeof msg.player === 'string' && typeof msg.text === 'string') {
          processGuess(msg.player, msg.nickname || msg.player, msg.profilePic || '', msg.text);
        }
        break;
      default:
        LOG.warn(`Unknown action: ${msg.action}`);
    }
  });

  ws.on('close', () => LOG.info('Overlay client disconnected'));
});

// ── Start server ─────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  LOG.info(`Server running on http://localhost:${PORT}`);
  LOG.info('Open the URL in your browser for the overlay');
  startRound();
});
