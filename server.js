const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Server } = require('http');
const THREE = require('three');

const app = express();
const server = Server(app);

app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// MongoDB connection
mongoose.connect(process.env.MONGODB_URL || 'mongodb://localhost:27017/hexploits', {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Memory store for verification codes
const verificationCodes = new Map();
// Memory store for sessions
const sessions = new Map();

// Schemas
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    email: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    role: { type: String, default: 'user', enum: ['user', 'mod', 'vip', 'owner'] },
    isVerified: { type: Boolean, default: false },
    balance: { type: Number, default: 1250 },
    profilePic: { type: String, default: '' },
    banner: { type: String, default: '#1a1a2e' },
    bio: { type: String, default: '' },
    customRoles: [{ 
        roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomRole' },
        name: String,
        color: String
    }],
    joinDate: { type: Date, default: Date.now },
    lastUsernameChange: { type: Date, default: Date.now },
    isBanned: { type: Boolean, default: false },
    chatHistory: [{
        messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
        content: String,
        timestamp: { type: Date, default: Date.now }
    }],
    settings: {
        theme: { type: String, default: 'dark' },
        notifications: { type: Boolean, default: true }
    }
});

const messageSchema = new mongoose.Schema({
    user: { 
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        username: String,
        profilePic: String,
        role: String,
        isVIP: Boolean
    },
    content: String,
    image: String,
    deleted: { type: Boolean, default: false },
    deletedBy: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const customRoleSchema = new mongoose.Schema({
    name: { type: String, unique: true, required: true },
    color: { type: String, default: '#00f2ff' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const CustomRole = mongoose.model('CustomRole', customRoleSchema);

// Middleware
const authenticate = async (req, res, next) => {
    try {
        const sessionId = req.headers.authorization;
        if (!sessionId) return res.status(401).json({ error: 'No session' });

        const session = sessions.get(sessionId);
        if (!session) return res.status(401).json({ error: 'Invalid session' });

        req.user = await User.findById(session.userId);
        next();
    } catch (err) {
        res.status(401).json({ error: 'Authentication error' });
    }
};

const isOwner = (req, res, next) => {
    if (req.user.role === 'owner') next();
    else res.status(403).json({ error: 'Owner only' });
};

const isModOrHigher = (req, res, next) => {
    if (['mod', 'owner'].includes(req.user.role)) next();
    else res.status(403).json({ error: 'Moderator required' });
};

// File upload setup
const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// Generate session ID
function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Routes

// Auth routes
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
        }

        // Check if user already exists
        const existingUser = await User.findOne({ $or: [{ username }, { email }] });
        if (existingUser) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }

        // FIRST USER BECOMES OWNER
        const userCount = await User.countDocuments();
        const role = userCount === 0 ? 'owner' : 'user';

        // Create user with plain text password
        const user = new User({ 
            username, 
            email, 
            password,
            role
        });
        await user.save();

        // Generate verification code
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        verificationCodes.set(email, { 
            code, 
            expires: Date.now() + 10 * 60 * 1000,
            userId: user._id 
        });

        // Send verification email
        const mailOptions = {
            from: process.env.EMAIL_USER || 'noreply@hexploits.com',
            to: email,
            subject: 'HEXploits - Verify Your Account',
            html: `
                <div style="font-family: monospace; max-width: 600px; margin: 0 auto; background: #0a0a0f; color: #e0e0e0;">
                    <div style="background: #1a1a2e; padding: 30px; text-align: center; color: white; border-bottom: 2px solid #00f2ff;">
                        <h1 style="font-size: 32px; color: #00f2ff; letter-spacing: 2px;">HEXPLOITS</h1>
                        <p style="opacity: 0.9;">ENCRYPTED ACCESS ONLY</p>
                    </div>
                    <div style="padding: 30px;">
                        <h2 style="color: #00f2ff;">Verification Code</h2>
                        <p>Hello ${username},</p>
                        <p>Your verification code is:</p>
                        <div style="background: rgba(0,242,255,0.1); padding: 20px; margin: 20px 0; border: 1px solid #00f2ff; border-radius: 5px; text-align: center;">
                            <code style="font-size: 32px; letter-spacing: 10px; color: #00f2ff; font-family: monospace;">${code}</code>
                        </div>
                        <p style="color: #ff4444; font-size: 14px;">⚠️ This code expires in 10 minutes</p>
                    </div>
                </div>
            `
        };

        // Try to send email, but if no email config, just log it
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS
                }
            });
            await transporter.sendMail(mailOptions);
        } else {
            console.log(`=== VERIFICATION CODE ===`);
            console.log(`For: ${username} (${email})`);
            console.log(`Code: ${code}`);
            console.log(`=========================`);
        }

        res.json({ 
            message: 'User registered. Check email for verification code.',
            userId: user._id 
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/verify', async (req, res) => {
    const { email, code } = req.body;
    const stored = verificationCodes.get(email);

    if (!stored) return res.status(400).json({ error: 'No verification requested' });
    if (Date.now() > stored.expires) {
        verificationCodes.delete(email);
        return res.status(400).json({ error: 'Code expired' });
    }
    if (stored.code !== code) return res.status(400).json({ error: 'Invalid code' });

    // Mark user as verified
    await User.findByIdAndUpdate(stored.userId, { isVerified: true });
    verificationCodes.delete(email);

    // Get user
    const user = await User.findById(stored.userId);
    
    // Create session
    const sessionId = generateSessionId();
    sessions.set(sessionId, { 
        userId: user._id,
        createdAt: Date.now()
    });

    res.json({ 
        sessionId,
        user: {
            _id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            isVerified: user.isVerified,
            balance: user.balance,
            profilePic: user.profilePic,
            banner: user.banner,
            bio: user.bio,
            customRoles: user.customRoles,
            joinDate: user.joinDate,
            isVIP: user.role === 'vip',
            settings: user.settings
        }
    });
});

app.post('/api/login', async (req, res) => {
    const { identifier, password } = req.body;
    
    // Find user by username or email
    const user = await User.findOne({
        $or: [{ email: identifier }, { username: identifier }]
    });

    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password (plain text comparison)
    if (user.password !== password) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isVerified) {
        return res.status(401).json({ error: 'Account not verified' });
    }

    if (user.isBanned) {
        return res.status(403).json({ error: 'Account banned' });
    }

    // Create session
    const sessionId = generateSessionId();
    sessions.set(sessionId, { 
        userId: user._id,
        createdAt: Date.now()
    });

    res.json({ 
        sessionId,
        user: {
            _id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            isVerified: user.isVerified,
            balance: user.balance,
            profilePic: user.profilePic,
            banner: user.banner,
            bio: user.bio,
            customRoles: user.customRoles,
            joinDate: user.joinDate,
            isVIP: user.role === 'vip',
            settings: user.settings
        }
    });
});

app.post('/api/logout', authenticate, (req, res) => {
    const sessionId = req.headers.authorization;
    sessions.delete(sessionId);
    res.json({ message: 'Logged out' });
});

// Other API routes remain the same as before...

// Serve HTML
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>HEXploits | Dark Sector</title>
    <style>
        :root {
            --glass: rgba(10, 10, 15, 0.85);
            --liquid: blur(30px) saturate(160%);
            --accent: #00f2ff;
            --hex-gold: #ffcc00;
            --danger: #ff4444;
            --mod-color: #ff6b6b;
            --owner-color: #9d4edd;
            --vip-color: #ffd700;
        }

        * { 
            margin: 0; 
            padding: 0; 
            box-sizing: border-box; 
            font-family: "Consolas", monospace; 
        }
        body { 
            background: #000; 
            color: #e0e0e0; 
            overflow: hidden; 
            height: 100vh; 
            cursor: default;
        }

        #canvas-bg { 
            position: fixed; 
            inset: 0; 
            z-index: -1; 
        }

        /* Auth Screens */
        #auth-overlay {
            position: fixed; 
            inset: 0; 
            z-index: 5000;
            background: #000; 
            display: flex; 
            flex-direction: column;
            justify-content: center; 
            align-items: center;
            transition: opacity 0.8s ease;
        }
        .auth-box {
            background: var(--glass); 
            padding: 40px; 
            border-radius: 20px;
            border: 1px solid var(--accent); 
            text-align: center;
            backdrop-filter: var(--liquid); 
            box-shadow: 0 0 50px rgba(0, 242, 255, 0.1);
            width: 350px;
        }
        .auth-tabs { 
            display: flex; 
            margin-bottom: 30px; 
        }
        .auth-tab { 
            flex: 1; 
            padding: 10px; 
            cursor: pointer; 
            background: transparent; 
            border: 1px solid rgba(255,255,255,0.1);
            color: rgba(255,255,255,0.5); 
            transition: all 0.3s;
        }
        .auth-tab.active { 
            background: rgba(0,242,255,0.1); 
            color: var(--accent); 
            border-color: var(--accent);
        }
        .auth-form { display: none; }
        .auth-form.active { display: block; }
        .auth-input {
            background: rgba(255,255,255,0.05); 
            border: 1px solid var(--accent);
            padding: 12px; 
            border-radius: 5px; 
            color: white; 
            width: 100%;
            margin-top: 15px; 
            outline: none; 
            text-align: center; 
            font-size: 16px;
        }
        .auth-btn {
            background: linear-gradient(45deg, #00f2ff, #0066ff);
            border: none; 
            padding: 12px; 
            border-radius: 5px;
            color: white; 
            width: 100%; 
            margin-top: 20px;
            cursor: pointer; 
            font-weight: bold; 
            transition: all 0.3s;
        }
        .auth-btn:hover { 
            transform: translateY(-2px); 
            box-shadow: 0 5px 15px rgba(0,242,255,0.3); 
        }

        /* Verification Tick */
        .verified-tick {
            display: inline-block;
            width: 16px;
            height: 16px;
            background-image: url('https://files.catbox.moe/u0s9fi.webp');
            background-size: contain;
            background-repeat: no-repeat;
            background-position: center;
            vertical-align: middle;
            margin-left: 5px;
        }

        /* Main UI */
        #main-ui { 
            display: none; 
            opacity: 0; 
            transition: opacity 1s; 
            height: 100vh; 
        }

        .top-bar {
            position: fixed; 
            top: 0; 
            left: 0; 
            right: 0;
            background: rgba(10,10,15,0.9); 
            backdrop-filter: blur(10px);
            padding: 10px 25px; 
            display: flex; 
            justify-content: space-between;
            align-items: center; 
            z-index: 1000; 
            border-bottom: 1px solid rgba(0,242,255,0.2);
        }
        #clock { 
            font-size: 18px; 
            font-weight: bold; 
            color: var(--accent); 
            text-shadow: 0 0 10px var(--accent); 
        }

        .currency-display {
            background: rgba(0,0,0,0.5); 
            border: 1px solid var(--hex-gold);
            padding: 5px 15px; 
            border-radius: 10px; 
            color: var(--hex-gold); 
            font-size: 14px;
        }

        .user-menu {
            display: flex; 
            align-items: center; 
            gap: 15px;
        }
        .user-avatar {
            width: 40px; 
            height: 40px; 
            border-radius: 50%;
            border: 2px solid var(--accent); 
            cursor: pointer;
            object-fit: cover;
        }
        .settings-btn {
            background: transparent;
            border: 1px solid var(--accent);
            color: var(--accent);
            padding: 8px 15px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 12px;
        }

        /* Chat Layout */
        .chat-container {
            display: grid;
            grid-template-columns: 250px 1fr 300px;
            gap: 20px;
            padding: 70px 25px 25px 25px;
            height: calc(100vh - 60px);
        }

        .panel {
            background: var(--glass);
            backdrop-filter: var(--liquid);
            border-radius: 15px;
            border: 1px solid rgba(255,255,255,0.1);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        /* Users Panel */
        .users-header {
            padding: 15px;
            background: rgba(0,242,255,0.05);
            border-bottom: 1px solid rgba(255,255,255,0.1);
            font-size: 14px;
        }
        .users-list {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
        }
        .user-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px;
            border-radius: 8px;
            margin-bottom: 5px;
            cursor: pointer;
            transition: all 0.3s;
        }
        .user-item:hover {
            background: rgba(255,255,255,0.05);
        }
        .user-item-avatar {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            border: 1px solid rgba(0,242,255,0.3);
            object-fit: cover;
        }
        .user-item-name {
            flex: 1;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .user-role {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 3px;
        }
        .role-owner { background: var(--owner-color); color: white; }
        .role-mod { background: var(--mod-color); color: white; }
        .role-vip { background: var(--vip-color); color: #000; }

        /* Chat Area */
        .chat-header {
            padding: 15px;
            background: rgba(0,242,255,0.05);
            border-bottom: 1px solid rgba(255,255,255,0.1);
            font-size: 14px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .chat-area {
            flex: 1;
            padding: 15px;
            font-size: 14px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        .message {
            display: flex;
            gap: 10px;
            align-items: flex-start;
        }
        .msg-avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            border: 1px solid rgba(0,242,255,0.3);
            object-fit: cover;
            flex-shrink: 0;
            cursor: pointer;
        }
        .msg-content {
            flex: 1;
            min-width: 0;
        }
        .msg-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 5px;
            flex-wrap: wrap;
        }
        .msg-username {
            font-weight: bold;
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .msg-username.owner { color: var(--owner-color); }
        .msg-username.mod { color: var(--mod-color); }
        .msg-username.vip { color: var(--vip-color); }
        
        .msg-custom-role {
            font-size: 11px;
            padding: 1px 6px;
            border-radius: 3px;
            margin-left: 5px;
        }
        .msg-time {
            font-size: 11px;
            opacity: 0.5;
            margin-left: auto;
        }
        .msg-text {
            word-break: break-word;
            margin-top: 5px;
            line-height: 1.4;
        }
        .msg-image {
            max-width: 300px;
            max-height: 300px;
            border-radius: 8px;
            margin-top: 10px;
            cursor: pointer;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .deleted-msg {
            font-style: italic;
            opacity: 0.5;
            padding: 10px;
            font-size: 12px;
            background: rgba(255,255,255,0.02);
            border-radius: 5px;
        }
        .chat-input-container {
            display: flex;
            padding: 15px;
            gap: 10px;
            border-top: 1px solid rgba(255,255,255,0.1);
        }
        .chat-input {
            flex: 1;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            padding: 12px;
            color: white;
            border-radius: 8px;
            outline: none;
            font-size: 14px;
        }
        .file-upload-btn {
            background: rgba(0,242,255,0.1);
            border: 1px solid var(--accent);
            color: var(--accent);
            padding: 0 15px;
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            transition: all 0.3s;
        }
        .file-upload-btn:hover {
            background: rgba(0,242,255,0.2);
        }

        /* Settings Panel */
        .settings-panel {
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        .settings-section {
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 10px;
            padding: 15px;
        }
        .settings-section h3 {
            color: var(--accent);
            margin-bottom: 10px;
            font-size: 16px;
        }
        .settings-input {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            padding: 10px;
            border-radius: 5px;
            color: white;
            width: 100%;
            margin-bottom: 10px;
            outline: none;
        }
        .settings-textarea {
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(255,255,255,0.1);
            padding: 10px;
            border-radius: 5px;
            color: white;
            width: 100%;
            margin-bottom: 10px;
            outline: none;
            resize: vertical;
            min-height: 80px;
            font-family: inherit;
        }

        /* Profile Modal */
        .profile-modal {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.9);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 2000;
        }
        .profile-modal.active {
            display: flex;
        }
        .profile-card {
            background: var(--glass);
            border-radius: 20px;
            border: 1px solid var(--accent);
            width: 400px;
            max-height: 80vh;
            overflow-y: auto;
            backdrop-filter: var(--liquid);
        }
        .profile-banner {
            height: 120px;
            background: var(--owner-color);
            border-radius: 20px 20px 0 0;
            position: relative;
            background-size: cover;
            background-position: center;
        }
        .profile-avatar {
            width: 100px;
            height: 100px;
            border-radius: 50%;
            border: 3px solid var(--accent);
            position: absolute;
            bottom: -50px;
            left: 50%;
            transform: translateX(-50%);
            object-fit: cover;
            background: #000;
        }
        .profile-info {
            padding: 60px 30px 30px 30px;
            text-align: center;
        }
        .profile-name {
            font-size: 24px;
            color: var(--accent);
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
        }
        .profile-name.owner { color: var(--owner-color); }
        .profile-name.mod { color: var(--mod-color); }
        .profile-name.vip { color: var(--vip-color); }
        
        .profile-bio {
            opacity: 0.8;
            margin: 20px 0;
            line-height: 1.6;
            min-height: 60px;
        }
        .profile-roles {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            justify-content: center;
            margin-top: 20px;
        }
        .profile-role {
            font-size: 11px;
            padding: 3px 10px;
            border-radius: 20px;
            border: 1px solid;
        }
        .profile-stats {
            display: flex;
            justify-content: space-around;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid rgba(255,255,255,0.1);
        }
        .stat-item {
            text-align: center;
        }
        .stat-value {
            font-size: 20px;
            color: var(--accent);
        }
        .stat-label {
            font-size: 12px;
            opacity: 0.7;
        }

        /* Settings Modal */
        .settings-modal {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.9);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 2001;
        }
        .settings-modal.active {
            display: flex;
        }
        .settings-card {
            background: var(--glass);
            border-radius: 20px;
            border: 1px solid var(--accent);
            width: 500px;
            max-height: 80vh;
            overflow-y: auto;
            backdrop-filter: var(--liquid);
            padding: 30px;
        }

        /* Admin Panel */
        .admin-panel {
            position: fixed;
            right: 30px;
            bottom: 30px;
            background: var(--glass);
            padding: 20px;
            border-radius: 10px;
            border: 1px solid var(--owner-color);
            display: none;
            z-index: 1001;
            width: 300px;
        }
        .admin-panel.active {
            display: block;
        }
        .admin-input {
            background: rgba(255,255,255,0.05);
            border: 1px solid var(--owner-color);
            padding: 8px;
            border-radius: 5px;
            color: white;
            width: 100%;
            margin: 5px 0;
            outline: none;
        }

        /* Verification Modal */
        .verification-modal {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.9);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 6000;
        }
        .verification-modal.active {
            display: flex;
        }

        /* Reset Modal */
        .reset-modal {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.9);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 6001;
        }
        .reset-modal.active {
            display: flex;
        }

        /* Killswitch */
        .killswitch-hint {
            position: fixed;
            bottom: 10px;
            left: 10px;
            font-size: 10px;
            opacity: 0.3;
        }

        /* Scrollbar */
        ::-webkit-scrollbar {
            width: 8px;
        }
        ::-webkit-scrollbar-track {
            background: rgba(0,0,0,0.2);
        }
        ::-webkit-scrollbar-thumb {
            background: var(--accent);
            border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: #00ccff;
        }
    </style>
</head>
<body>
    <div id="canvas-bg"></div>

    <!-- Auth Screens -->
    <div id="auth-overlay">
        <div class="auth-box">
            <div class="auth-tabs">
                <div class="auth-tab active" onclick="switchTab('login')">LOGIN</div>
                <div class="auth-tab" onclick="switchTab('signup')">SIGNUP</div>
            </div>
            
            <div id="login-form" class="auth-form active">
                <input type="text" id="login-identifier" class="auth-input" placeholder="Username or Email">
                <input type="password" id="login-password" class="auth-input" placeholder="Password">
                <button class="auth-btn" onclick="login()">DECRYPT ACCESS</button>
                <p style="font-size: 10px; margin-top: 15px; opacity: 0.4;">
                    <span onclick="showResetModal()" style="cursor: pointer; color: var(--accent);">
                        FORGOT PASSWORD?
                    </span>
                </p>
            </div>
            
            <div id="signup-form" class="auth-form">
                <input type="text" id="signup-username" class="auth-input" placeholder="Username">
                <input type="email" id="signup-email" class="auth-input" placeholder="Email">
                <input type="password" id="signup-password" class="auth-input" placeholder="Password">
                <button class="auth-btn" onclick="signup()">CREATE ACCOUNT</button>
                <p style="font-size: 10px; margin-top: 15px; opacity: 0.4;">
                    Username: letters, numbers, underscores only
                </p>
            </div>
        </div>
    </div>

    <!-- Verification Modal -->
    <div id="verification-modal" class="verification-modal">
        <div class="auth-box">
            <h3 style="color: var(--accent); margin-bottom: 20px;">VERIFICATION REQUIRED</h3>
            <p style="font-size: 14px; opacity: 0.8;">Check your email for the verification code</p>
            <div style="font-size: 32px; letter-spacing: 10px; color: var(--accent); margin: 30px 0; font-family: monospace;">
                <span id="verification-code-display">------</span>
            </div>
            <input type="text" id="verification-input" class="auth-input" placeholder="Enter 6-digit code" maxlength="6">
            <button class="auth-btn" onclick="verifyCode()" style="margin-top: 20px;">VERIFY</button>
            <p style="font-size: 10px; color: var(--danger); margin-top: 15px;">
                Code expires in 10 minutes
            </p>
        </div>
    </div>

    <!-- Main UI -->
    <div id="main-ui">
        <div class="top-bar">
            <div style="display: flex; align-items: center; gap: 30px;">
                <h1 style="color: var(--accent); letter-spacing: 3px; font-size: 18px;">HEXPLOITS</h1>
                <div class="currency-display">⬢ <span id="balance">1,250</span></div>
            </div>
            
            <div class="user-menu">
                <div id="clock">00:00:00</div>
                <button onclick="showSettingsPanel()" class="settings-btn">SETTINGS</button>
                <img id="user-avatar" class="user-avatar" onclick="showProfile(currentUser._id)" src="" alt="Avatar">
                <button onclick="showAdminPanel()" id="admin-btn" style="
                    background: rgba(157, 78, 221, 0.2); 
                    border: 1px solid var(--owner-color); 
                    color: var(--owner-color); 
                    padding: 5px 15px; 
                    border-radius: 5px;
                    cursor: pointer;
                    display: none;
                ">ADMIN</button>
                <button onclick="logout()" style="
                    background: rgba(255, 68, 68, 0.2);
                    border: 1px solid var(--danger);
                    color: var(--danger);
                    padding: 5px 15px;
                    border-radius: 5px;
                    cursor: pointer;
                    font-size: 12px;
                ">LOGOUT</button>
            </div>
        </div>

        <div class="chat-container">
            <!-- Left Panel - Users -->
            <div class="panel">
                <div class="users-header">
                    <span>ONLINE USERS</span>
                    <span id="online-count" style="float: right;">0</span>
                </div>
                <div class="users-list" id="users-list">
                    <!-- Users loaded here -->
                </div>
            </div>

            <!-- Middle Panel - Chat -->
            <div class="panel">
                <div class="chat-header">
                    <span>NEURAL_LINK</span>
                    <span id="chat-info">0 messages</span>
                </div>
                <div class="chat-area" id="chat-area">
                    <!-- Messages loaded here -->
                </div>
                <div class="chat-input-container">
                    <input type="file" id="image-upload" accept="image/*" style="display: none;">
                    <div class="file-upload-btn" onclick="document.getElementById('image-upload').click()">
                        📷
                    </div>
                    <input type="text" class="chat-input" id="chat-input" 
                           placeholder="Type your message..." 
                           onkeydown="if(event.key === 'Enter') sendMessage()">
                </div>
            </div>

            <!-- Right Panel - Settings -->
            <div class="panel">
                <div class="settings-panel" id="settings-panel">
                    <div class="settings-section">
                        <h3>PROFILE SETTINGS</h3>
                        <input type="text" id="settings-username" class="settings-input" placeholder="Username">
                        <textarea id="settings-bio" class="settings-textarea" placeholder="Bio"></textarea>
                        <input type="text" id="settings-banner" class="settings-input" placeholder="Banner Color (#hex)">
                        <div style="margin: 10px 0;">
                            <label style="font-size: 12px; opacity: 0.8;">Profile Picture:</label>
                            <input type="file" id="settings-profile-pic" accept="image/*" style="width: 100%; margin-top: 5px;">
                        </div>
                        <div style="margin: 10px 0;">
                            <label style="font-size: 12px; opacity: 0.8;">Banner Image:</label>
                            <input type="file" id="settings-banner-image" accept="image/*" style="width: 100%; margin-top: 5px;">
                        </div>
                        <button onclick="saveProfileSettings()" style="
                            background: var(--accent);
                            border: none;
                            color: #000;
                            padding: 10px 20px;
                            border-radius: 5px;
                            cursor: pointer;
                            width: 100%;
                            font-weight: bold;
                        ">SAVE PROFILE</button>
                    </div>
                    
                    <div class="settings-section">
                        <h3>CHANGE PASSWORD</h3>
                        <input type="password" id="settings-current-password" class="settings-input" placeholder="Current Password">
                        <input type="password" id="settings-new-password" class="settings-input" placeholder="New Password">
                        <input type="password" id="settings-confirm-password" class="settings-input" placeholder="Confirm Password">
                        <button onclick="changePassword()" style="
                            background: rgba(255,255,255,0.1);
                            border: 1px solid rgba(255,255,255,0.3);
                            color: white;
                            padding: 10px 20px;
                            border-radius: 5px;
                            cursor: pointer;
                            width: 100%;
                        ">CHANGE PASSWORD</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Profile Modal -->
    <div id="profile-modal" class="profile-modal" onclick="if(event.target === this) hideProfile()">
        <div class="profile-card">
            <div class="profile-banner" id="profile-banner"></div>
            <img id="profile-modal-avatar" class="profile-avatar" src="" alt="Avatar">
            <div class="profile-info">
                <div class="profile-name" id="profile-name">
                    <span id="profile-username">Username</span>
                </div>
                <div id="profile-roles" class="profile-roles"></div>
                <p class="profile-bio" id="profile-bio">No bio set</p>
                <div class="profile-stats">
                    <div class="stat-item">
                        <div class="stat-value" id="profile-balance">0</div>
                        <div class="stat-label">BALANCE</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value" id="profile-join-date">00/00</div>
                        <div class="stat-label">JOINED</div>
                    </div>
                </div>
                <div style="margin-top: 20px;">
                    <button onclick="hideProfile()" style="
                        background: transparent;
                        border: 1px solid rgba(255,255,255,0.3);
                        color: rgba(255,255,255,0.7);
                        padding: 8px 20px;
                        border-radius: 5px;
                        cursor: pointer;
                    ">CLOSE</button>
                </div>
            </div>
        </div>
    </div>

    <!-- Admin Panel -->
    <div id="admin-panel" class="admin-panel">
        <h3 style="color: var(--owner-color); margin-bottom: 10px;">ADMIN PANEL</h3>
        
        <div style="margin-bottom: 15px;">
            <h4 style="color: var(--accent); margin-bottom: 5px; font-size: 12px;">Custom Roles</h4>
            <input type="text" id="admin-role-name" class="admin-input" placeholder="Role Name">
            <input type="color" id="admin-role-color" class="admin-input" value="#00f2ff">
            <button onclick="createCustomRole()" style="
                background: var(--owner-color);
                border: none;
                color: white;
                padding: 5px 10px;
                border-radius: 3px;
                cursor: pointer;
                width: 100%;
                margin-top: 5px;
                font-size: 12px;
            ">CREATE ROLE</button>
        </div>
        
        <div style="margin-bottom: 15px;">
            <h4 style="color: var(--accent); margin-bottom: 5px; font-size: 12px;">User Management</h4>
            <input type="text" id="admin-user-id" class="admin-input" placeholder="User ID">
            <select id="admin-action" class="admin-input" onchange="toggleAdminFields()">
                <option value="role">Change Role</option>
                <option value="assign-role">Assign Custom Role</option>
                <option value="balance">Add Balance</option>
                <option value="ban">Ban User</option>
            </select>
            <div id="admin-extra-fields"></div>
            <button onclick="performAdminAction()" style="
                background: var(--owner-color);
                border: none;
                color: white;
                padding: 8px 15px;
                border-radius: 5px;
                cursor: pointer;
                width: 100%;
                margin-top: 10px;
            ">EXECUTE</button>
        </div>
        
        <button onclick="showAdminPanel()" style="
            background: transparent;
            border: 1px solid rgba(255,255,255,0.3);
            color: rgba(255,255,255,0.7);
            padding: 5px 10px;
            border-radius: 3px;
            cursor: pointer;
            width: 100%;
            font-size: 11px;
        ">CLOSE</button>
    </div>

    <div class="killswitch-hint">KILLSWITCH: `</div>

    <script>
        const API_URL = window.location.origin + '/api';
        let currentUser = null;
        let sessionId = null;
        let customRoles = [];
        let users = [];

        // Auth Functions
        function switchTab(tab) {
            document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
            
            document.querySelector(\`[onclick="switchTab('\${tab}')"]\`).classList.add('active');
            document.getElementById(\`\${tab}-form\`).classList.add('active');
        }

        async function signup() {
            const username = document.getElementById('signup-username').value;
            const email = document.getElementById('signup-email').value;
            const password = document.getElementById('signup-password').value;
            
            if (!/^[a-zA-Z0-9_]+$/.test(username)) {
                alert('Username can only contain letters, numbers, and underscores');
                return;
            }
            
            try {
                const response = await fetch(\`\${API_URL}/register\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, email, password })
                });
                
                const data = await response.json();
                
                if (response.ok) {
                    sessionStorage.setItem('pendingEmail', email);
                    sessionStorage.setItem('pendingUserId', data.userId);
                    showVerificationModal();
                } else {
                    alert(\`Error: \${data.error}\`);
                }
            } catch (err) {
                alert('Connection error');
            }
        }

        async function login() {
            const identifier = document.getElementById('login-identifier').value;
            const password = document.getElementById('login-password').value;
            
            try {
                const response = await fetch(\`\${API_URL}/login\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ identifier, password })
                });
                
                const data = await response.json();
                
                if (response.ok) {
                    startSession(data.sessionId, data.user);
                } else {
                    alert(\`Error: \${data.error}\`);
                }
            } catch (err) {
                alert('Connection error');
            }
        }

        function showVerificationModal() {
            document.getElementById('verification-modal').classList.add('active');
        }

        async function verifyCode() {
            const email = sessionStorage.getItem('pendingEmail');
            const code = document.getElementById('verification-input').value;
            
            try {
                const response = await fetch(\`\${API_URL}/verify\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, code })
                });
                
                const data = await response.json();
                
                if (response.ok) {
                    sessionStorage.removeItem('pendingEmail');
                    sessionStorage.removeItem('pendingUserId');
                    document.getElementById('verification-modal').classList.remove('active');
                    startSession(data.sessionId, data.user);
                } else {
                    alert(\`Error: \${data.error}\`);
                }
            } catch (err) {
                alert('Connection error');
            }
        }

        function startSession(userSessionId, user) {
            sessionId = userSessionId;
            currentUser = user;
            localStorage.setItem('sessionId', sessionId);
            localStorage.setItem('userId', user._id);
            
            document.getElementById('auth-overlay').style.opacity = '0';
            setTimeout(() => {
                document.getElementById('auth-overlay').style.display = 'none';
                document.getElementById('main-ui').style.display = 'block';
                setTimeout(() => document.getElementById('main-ui').style.opacity = '1', 50);
                
                updateUserUI();
                loadMessages();
                loadUsers();
                loadCustomRoles();
                startPolling();
            }, 800);
        }

        async function logout() {
            try {
                await fetch(\`\${API_URL}/logout\`, {
                    method: 'POST',
                    headers: {
                        'Authorization': sessionId
                    }
                });
                
                sessionId = null;
                currentUser = null;
                localStorage.removeItem('sessionId');
                localStorage.removeItem('userId');
                
                document.getElementById('main-ui').style.opacity = '0';
                setTimeout(() => {
                    document.getElementById('main-ui').style.display = 'none';
                    document.getElementById('auth-overlay').style.display = 'flex';
                    setTimeout(() => {
                        document.getElementById('auth-overlay').style.opacity = '1';
                    }, 50);
                }, 800);
            } catch (err) {
                console.error('Logout error:', err);
            }
        }

        function updateUserUI() {
            document.getElementById('balance').textContent = currentUser.balance.toLocaleString();
            
            const avatar = document.getElementById('user-avatar');
            if (currentUser.profilePic) {
                avatar.src = currentUser.profilePic;
            } else {
                avatar.src = \`https://ui-avatars.com/api/?name=\${encodeURIComponent(currentUser.username)}&background=0a0a0f&color=00f2ff&bold=true\`;
            }
            
            if (currentUser.role === 'owner') {
                document.getElementById('admin-btn').style.display = 'block';
            }
            
            // Update settings panel
            document.getElementById('settings-username').value = currentUser.username;
            document.getElementById('settings-bio').value = currentUser.bio || '';
            document.getElementById('settings-banner').value = currentUser.banner.startsWith('#') ? currentUser.banner : '#1a1a2e';
        }

        // Chat Functions
        async function loadMessages() {
            try {
                const response = await fetch(\`\${API_URL}/messages\`);
                const messages = await response.json();
                
                const chatArea = document.getElementById('chat-area');
                chatArea.innerHTML = '';
                
                if (messages.length === 0) {
                    chatArea.innerHTML = '<p style="text-align: center; opacity: 0.5; padding: 20px;">No messages yet</p>';
                    return;
                }
                
                document.getElementById('chat-info').textContent = \`\${messages.length} messages\`;
                
                messages.forEach(msg => {
                    if (msg.deleted) {
                        const deletedMsg = document.createElement('div');
                        deletedMsg.className = 'deleted-msg';
                        deletedMsg.textContent = \`(message deleted by \${msg.deletedBy || 'user'})\`;
                        chatArea.appendChild(deletedMsg);
                    } else {
                        const messageDiv = document.createElement('div');
                        messageDiv.className = 'message';
                        
                        let roleClass = '';
                        if (msg.user.role === 'owner') roleClass = 'owner';
                        else if (msg.user.role === 'mod') roleClass = 'mod';
                        else if (msg.user.isVIP) roleClass = 'vip';
                        
                        messageDiv.innerHTML = \`
                            <img src="\${msg.user.profilePic || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(msg.user.username)}&background=0a0a0f&color=00f2ff&bold=true\`}" 
                                 class="msg-avatar" onclick="showProfile('\${msg.user.userId}')">
                            <div class="msg-content">
                                <div class="msg-header">
                                    <span class="msg-username \${roleClass}">
                                        \${msg.user.username}
                                        \${(msg.user.role === 'owner' || msg.user.role === 'mod' || msg.user.isVIP) ? 
                                            '<span class="verified-tick"></span>' : ''}
                                    </span>
                                    \${msg.user.customRoles && msg.user.customRoles.length > 0 ? 
                                        msg.user.customRoles.map(role => 
                                            \`<span class="msg-custom-role" style="background: \${role.color}">\${role.name}</span>\`
                                        ).join('') : ''}
                                    <span class="msg-time">\${new Date(msg.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                                    \${(currentUser._id === msg.user.userId || currentUser.role === 'mod' || currentUser.role === 'owner') ?
                                        \`<span style="margin-left: 10px; cursor: pointer; opacity: 0.5; font-size: 16px;" 
                                              onclick="deleteMessage('\${msg._id}')" title="Delete message">×</span>\` : ''}
                                </div>
                                <div class="msg-text">\${msg.content}</div>
                                \${msg.image ? 
                                    \`<img src="\${msg.image}" class="msg-image" onclick="viewImage('\${msg.image}')">\` : ''}
                            </div>
                        \`;
                        
                        chatArea.appendChild(messageDiv);
                    }
                });
                
                chatArea.scrollTop = chatArea.scrollHeight;
            } catch (err) {
                console.error('Error loading messages:', err);
            }
        }

        async function sendMessage() {
            const input = document.getElementById('chat-input');
            const content = input.value.trim();
            const fileInput = document.getElementById('image-upload');
            
            if (!content && !fileInput.files[0]) return;
            
            const formData = new FormData();
            if (content) formData.append('content', content);
            if (fileInput.files[0]) formData.append('image', fileInput.files[0]);
            
            try {
                const response = await fetch(\`\${API_URL}/messages\`, {
                    method: 'POST',
                    headers: {
                        'Authorization': sessionId
                    },
                    body: formData
                });
                
                if (response.ok) {
                    input.value = '';
                    fileInput.value = '';
                    loadMessages();
                } else {
                    const error = await response.json();
                    alert(\`Error: \${error.error}\`);
                }
            } catch (err) {
                console.error('Error sending message:', err);
            }
        }

        async function deleteMessage(messageId) {
            if (!confirm('Delete this message?')) return;
            
            try {
                const response = await fetch(\`\${API_URL}/messages/\${messageId}\`, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': sessionId,
                        'Content-Type': 'application/json'
                    }
                });
                
                if (response.ok) {
                    loadMessages();
                } else {
                    const error = await response.json();
                    alert(\`Error: \${error.error}\`);
                }
            } catch (err) {
                console.error('Error deleting message:', err);
            }
        }

        // Users List
        async function loadUsers() {
            try {
                const response = await fetch(\`\${API_URL}/users\`);
                users = await response.json();
                const usersList = document.getElementById('users-list');
                usersList.innerHTML = '';
                
                document.getElementById('online-count').textContent = \`\${users.length} online\`;
                
                users.forEach(user => {
                    const userDiv = document.createElement('div');
                    userDiv.className = 'user-item';
                    userDiv.onclick = () => showProfile(user._id);
                    
                    let roleBadge = '';
                    if (user.role === 'owner') roleBadge = '<span class="user-role role-owner">OWNER</span>';
                    else if (user.role === 'mod') roleBadge = '<span class="user-role role-mod">MOD</span>';
                    else if (user.role === 'vip') roleBadge = '<span class="user-role role-vip">VIP</span>';
                    
                    userDiv.innerHTML = \`
                        <img src="\${user.profilePic || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(user.username)}&background=0a0a0f&color=00f2ff&bold=true\`}" 
                             class="user-item-avatar">
                        <div class="user-item-name">
                            \${user.username}
                            \${(user.role === 'owner' || user.role === 'mod' || user.role === 'vip') ? 
                                '<span class="verified-tick"></span>' : ''}
                        </div>
                        \${roleBadge}
                    \`;
                    
                    usersList.appendChild(userDiv);
                });
            } catch (err) {
                console.error('Error loading users:', err);
            }
        }

        // Profile Functions
        async function showProfile(userId) {
            try {
                const response = await fetch(\`\${API_URL}/profile/\${userId}\`, {
                    headers: {
                        'Authorization': sessionId
                    }
                });
                
                const user = await response.json();
                
                const profileName = document.getElementById('profile-name');
                profileName.className = 'profile-name';
                if (user.role === 'owner') profileName.classList.add('owner');
                else if (user.role === 'mod') profileName.classList.add('mod');
                else if (user.role === 'vip') profileName.classList.add('vip');
                
                document.getElementById('profile-username').textContent = user.username;
                document.getElementById('profile-bio').textContent = user.bio || 'No bio set';
                document.getElementById('profile-balance').textContent = user.balance.toLocaleString();
                document.getElementById('profile-join-date').textContent = 
                    new Date(user.joinDate).toLocaleDateString();
                
                const avatar = document.getElementById('profile-modal-avatar');
                if (user.profilePic) {
                    avatar.src = user.profilePic;
                } else {
                    avatar.src = \`https://ui-avatars.com/api/?name=\${encodeURIComponent(user.username)}&background=0a0a0f&color=00f2ff&bold=true\`;
                }
                
                const banner = document.getElementById('profile-banner');
                if (user.banner.startsWith('#')) {
                    banner.style.background = user.banner;
                } else if (user.banner) {
                    banner.style.background = \`url(\${user.banner}) center/cover\`;
                } else {
                    banner.style.background = 'linear-gradient(135deg, var(--owner-color), #6c63ff)';
                }
                
                const rolesContainer = document.getElementById('profile-roles');
                rolesContainer.innerHTML = '';
                
                if (user.role === 'owner') {
                    const roleSpan = document.createElement('span');
                    roleSpan.className = 'profile-role';
                    roleSpan.style.background = 'var(--owner-color)';
                    roleSpan.style.color = 'white';
                    roleSpan.textContent = 'OWNER';
                    rolesContainer.appendChild(roleSpan);
                } else if (user.role === 'mod') {
                    const roleSpan = document.createElement('span');
                    roleSpan.className = 'profile-role';
                    roleSpan.style.background = 'var(--mod-color)';
                    roleSpan.style.color = 'white';
                    roleSpan.textContent = 'MODERATOR';
                    rolesContainer.appendChild(roleSpan);
                } else if (user.role === 'vip') {
                    const roleSpan = document.createElement('span');
                    roleSpan.className = 'profile-role';
                    roleSpan.style.background = 'var(--vip-color)';
                    roleSpan.style.color = '#000';
                    roleSpan.textContent = 'VIP';
                    rolesContainer.appendChild(roleSpan);
                }
                
                if (user.customRoles && user.customRoles.length > 0) {
                    user.customRoles.forEach(role => {
                        const roleSpan = document.createElement('span');
                        roleSpan.className = 'profile-role';
                        roleSpan.style.background = role.color;
                        roleSpan.style.color = '#000';
                        roleSpan.textContent = role.name;
                        rolesContainer.appendChild(roleSpan);
                    });
                }
                
                document.getElementById('profile-modal').classList.add('active');
            } catch (err) {
                console.error('Error loading profile:', err);
            }
        }

        function hideProfile() {
            document.getElementById('profile-modal').classList.remove('active');
        }

        // Settings Functions
        function showSettingsPanel() {
            alert('Settings panel would open here. In this single-file version, use the right panel for settings.');
        }

        async function saveProfileSettings() {
            const username = document.getElementById('settings-username').value;
            const bio = document.getElementById('settings-bio').value;
            const bannerColor = document.getElementById('settings-banner').value;
            const profilePicFile = document.getElementById('settings-profile-pic').files[0];
            const bannerFile = document.getElementById('settings-banner-image').files[0];
            
            const formData = new FormData();
            if (username !== currentUser.username) formData.append('username', username);
            if (bio !== currentUser.bio) formData.append('bio', bio);
            if (bannerColor && bannerColor.startsWith('#') && bannerColor !== currentUser.banner) {
                formData.append('banner', bannerColor);
            }
            if (profilePicFile) formData.append('profilePic', profilePicFile);
            if (bannerFile) formData.append('banner', bannerFile);
            
            try {
                const response = await fetch(\`\${API_URL}/settings/profile\`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': sessionId
                    },
                    body: formData
                });
                
                if (response.ok) {
                    const updatedUser = await response.json();
                    currentUser = updatedUser;
                    updateUserUI();
                    alert('Profile updated successfully');
                } else {
                    const error = await response.json();
                    alert(\`Error: \${error.error}\`);
                }
            } catch (err) {
                console.error('Error updating profile:', err);
            }
        }

        async function changePassword() {
            const currentPassword = document.getElementById('settings-current-password').value;
            const newPassword = document.getElementById('settings-new-password').value;
            const confirmPassword = document.getElementById('settings-confirm-password').value;
            
            if (newPassword !== confirmPassword) {
                alert('New passwords do not match');
                return;
            }
            
            try {
                const response = await fetch(\`\${API_URL}/settings/password\`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': sessionId,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ currentPassword, newPassword })
                });
                
                if (response.ok) {
                    alert('Password changed successfully');
                    document.getElementById('settings-current-password').value = '';
                    document.getElementById('settings-new-password').value = '';
                    document.getElementById('settings-confirm-password').value = '';
                } else {
                    const error = await response.json();
                    alert(\`Error: \${error.error}\`);
                }
            } catch (err) {
                console.error('Error changing password:', err);
            }
        }

        // Admin Functions
        async function loadCustomRoles() {
            if (currentUser.role !== 'owner') return;
            
            try {
                const response = await fetch(\`\${API_URL}/custom-roles\`, {
                    headers: {
                        'Authorization': sessionId
                    }
                });
                
                customRoles = await response.json();
            } catch (err) {
                console.error('Error loading custom roles:', err);
            }
        }

        function showAdminPanel() {
            document.getElementById('admin-panel').classList.toggle('active');
        }

        async function createCustomRole() {
            const name = document.getElementById('admin-role-name').value;
            const color = document.getElementById('admin-role-color').value;
            
            if (!name) {
                alert('Please enter a role name');
                return;
            }
            
            try {
                const response = await fetch(\`\${API_URL}/custom-roles\`, {
                    method: 'POST',
                    headers: {
                        'Authorization': sessionId,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ name, color })
                });
                
                if (response.ok) {
                    alert('Custom role created');
                    loadCustomRoles();
                    document.getElementById('admin-role-name').value = '';
                } else {
                    const error = await response.json();
                    alert(\`Error: \${error.error}\`);
                }
            } catch (err) {
                console.error('Error creating custom role:', err);
            }
        }

        function toggleAdminFields() {
            const action = document.getElementById('admin-action').value;
            const container = document.getElementById('admin-extra-fields');
            
            switch(action) {
                case 'role':
                    container.innerHTML = \`
                        <select id="admin-role" class="admin-input">
                            <option value="user">User</option>
                            <option value="mod">Moderator</option>
                            <option value="vip">VIP</option>
                        </select>
                    \`;
                    break;
                case 'assign-role':
                    let roleOptions = '<option value="">Select Role</option>';
                    customRoles.forEach(role => {
                        roleOptions += \`<option value="\${role._id}">\${role.name}</option>\`;
                    });
                    container.innerHTML = \`
                        <select id="admin-custom-role" class="admin-input">
                            \${roleOptions}
                        </select>
                    \`;
                    break;
                case 'balance':
                    container.innerHTML = \`
                        <input type="number" id="admin-amount" class="admin-input" placeholder="Amount" value="100">
                    \`;
                    break;
                case 'ban':
                    container.innerHTML = \`
                        <input type="text" id="admin-ban-reason" class="admin-input" placeholder="Ban Reason">
                    \`;
                    break;
            }
        }

        async function performAdminAction() {
            const userId = document.getElementById('admin-user-id').value;
            const action = document.getElementById('admin-action').value;
            
            if (!userId) {
                alert('Please enter a User ID');
                return;
            }
            
            let body = { userId };
            let endpoint = '';
            
            switch(action) {
                case 'role':
                    body.role = document.getElementById('admin-role').value;
                    endpoint = '/admin/role';
                    break;
                case 'assign-role':
                    const roleId = document.getElementById('admin-custom-role').value;
                    if (!roleId) {
                        alert('Please select a role');
                        return;
                    }
                    endpoint = \`/custom-roles/\${roleId}/assign\`;
                    break;
                case 'balance':
                    body.amount = parseInt(document.getElementById('admin-amount').value) || 0;
                    endpoint = '/admin/balance';
                    break;
                case 'ban':
                    body.reason = document.getElementById('admin-ban-reason').value || 'No reason provided';
                    endpoint = '/admin/ban';
                    break;
            }
            
            try {
                const response = await fetch(\`\${API_URL}\${endpoint}\`, {
                    method: 'POST',
                    headers: {
                        'Authorization': sessionId,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(body)
                });
                
                if (response.ok) {
                    alert('Action successful');
                    if (action === 'balance' && userId === currentUser._id) {
                        const data = await response.json();
                        currentUser.balance = data.balance;
                        updateUserUI();
                    }
                    if (action === 'role' || action === 'ban') {
                        loadUsers();
                    }
                } else {
                    const error = await response.json();
                    alert(\`Error: \${error.error}\`);
                }
            } catch (err) {
                console.error('Admin action error:', err);
                alert('Connection error');
            }
        }

        // Utility Functions
        function viewImage(url) {
            window.open(url, '_blank');
        }

        function startPolling() {
            setInterval(loadMessages, 3000);
            setInterval(loadUsers, 10000);
            if (currentUser.role === 'owner') {
                setInterval(loadCustomRoles, 15000);
            }
        }

        // Killswitch
        window.addEventListener('keydown', (e) => {
            if (e.key === '\`') {
                window.location.href = "https://sparxmaths.com";
            }
        });

        // Clock
        function updateClock() {
            const now = new Date();
            const timeStr = now.getHours().toString().padStart(2, '0') + ":" + 
                            now.getMinutes().toString().padStart(2, '0') + ":" + 
                            now.getSeconds().toString().padStart(2, '0');
            document.getElementById('clock').innerText = timeStr;
        }
        setInterval(updateClock, 1000);
        updateClock();

        // Three.js Background
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
        const renderer = new THREE.WebGLRenderer({ 
            alpha: true,
            antialias: true 
        });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        document.getElementById('canvas-bg').appendChild(renderer.domElement);

        const geo = new THREE.TorusKnotGeometry(10, 3, 100, 16);
        const mat = new THREE.MeshBasicMaterial({ 
            color: 0x00f2ff, 
            wireframe: true, 
            transparent: true, 
            opacity: 0.15 
        });
        const mesh = new THREE.Mesh(geo, mat);
        scene.add(mesh);
        camera.position.z = 30;

        function animate() {
            requestAnimationFrame(animate);
            mesh.rotation.y += 0.005;
            mesh.rotation.x += 0.002;
            renderer.render(scene, camera);
        }
        animate();

        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });

        // Auto-login
        window.addEventListener('load', async () => {
            const savedSessionId = localStorage.getItem('sessionId');
            const savedUserId = localStorage.getItem('userId');
            
            if (savedSessionId && savedUserId) {
                sessionId = savedSessionId;
                
                try {
                    const response = await fetch(\`\${API_URL}/profile/me\`, {
                        headers: { 'Authorization': sessionId }
                    });
                    
                    if (response.ok) {
                        const user = await response.json();
                        currentUser = user;
                        startSession(savedSessionId, user);
                    } else {
                        localStorage.removeItem('sessionId');
                        localStorage.removeItem('userId');
                    }
                } catch (err) {
                    localStorage.removeItem('sessionId');
                    localStorage.removeItem('userId');
                }
            }
        });

        // Image upload handler
        document.getElementById('image-upload').addEventListener('change', function() {
            if (this.files[0]) {
                sendMessage();
            }
        });

        // Close modals on outside click
        document.addEventListener('click', (e) => {
            if (e.target.id === 'profile-modal') hideProfile();
            if (e.target.id === 'verification-modal') {
                document.getElementById('verification-modal').classList.remove('active');
            }
        });
    </script>
</body>
</html>
    `);
});

// Additional API routes (simplified versions)
app.post('/api/settings/profile', authenticate, upload.fields([
    { name: 'profilePic', maxCount: 1 },
    { name: 'banner', maxCount: 1 }
]), async (req, res) => {
    try {
        const updates = {};
        const { username, bio, banner } = req.body;
        
        if (username && username !== req.user.username) {
            const daysSinceChange = (Date.now() - req.user.lastUsernameChange) / (1000 * 60 * 60 * 24);
            
            if (daysSinceChange < 15) {
                return res.status(400).json({ 
                    error: `Username can only be changed every 15 days. ${Math.ceil(15 - daysSinceChange)} days remaining.` 
                });
            }
            
            const existingUser = await User.findOne({ username });
            if (existingUser) {
                return res.status(400).json({ error: 'Username already taken' });
            }
            
            updates.username = username;
            updates.lastUsernameChange = Date.now();
        }
        
        if (bio !== undefined) updates.bio = bio;
        
        if (req.files?.profilePic) {
            updates.profilePic = `/uploads/${req.files.profilePic[0].filename}`;
        }
        
        if (banner && banner.startsWith('#')) {
            updates.banner = banner;
        } else if (req.files?.banner) {
            updates.banner = `/uploads/${req.files.banner[0].filename}`;
        }
        
        const updatedUser = await User.findByIdAndUpdate(
            req.user._id,
            updates,
            { new: true }
        ).select('-password -__v -chatHistory');
        
        res.json(updatedUser);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/settings/password', authenticate, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        
        if (req.user.password !== currentPassword) {
            return res.status(400).json({ error: 'Current password is incorrect' });
        }
        
        await User.findByIdAndUpdate(req.user._id, { password: newPassword });
        
        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/profile/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id)
            .select('-password -__v -chatHistory');
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        const customRoles = await CustomRole.find({ users: user._id });
        
        res.json({
            ...user.toObject(),
            customRoles: customRoles.map(role => ({
                _id: role._id,
                name: role.name,
                color: role.color
            }))
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/profile/me', authenticate, async (req, res) => {
    try {
        const user = await User.findById(req.user._id)
            .select('-password -__v');
        
        const customRoles = await CustomRole.find({ users: user._id });
        
        res.json({
            ...user.toObject(),
            customRoles: customRoles.map(role => ({
                _id: role._id,
                name: role.name,
                color: role.color
            }))
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/messages', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const messages = await Message.find({ deleted: false })
            .sort({ createdAt: -1 })
            .limit(limit);
        
        res.json(messages.reverse());
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/messages', authenticate, upload.single('image'), async (req, res) => {
    try {
        const user = req.user;
        
        const message = new Message({
            user: {
                userId: user._id,
                username: user.username,
                profilePic: user.profilePic,
                role: user.role,
                isVIP: user.role === 'vip'
            },
            content: req.body.content,
            image: req.file ? `/uploads/${req.file.filename}` : null
        });
        
        await message.save();
        
        await User.findByIdAndUpdate(user._id, {
            $push: {
                chatHistory: {
                    messageId: message._id,
                    content: req.body.content || '[Image]',
                    timestamp: Date.now()
                }
            }
        });
        
        res.json(message);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/messages/:id', authenticate, async (req, res) => {
    try {
        const message = await Message.findById(req.params.id);
        
        if (!message) return res.status(404).json({ error: 'Message not found' });
        
        const isOwner = req.user.role === 'owner';
        const isAuthor = message.user.userId.toString() === req.user._id.toString();
        const isMod = req.user.role === 'mod';
        
        if (!isOwner && !isAuthor && !isMod) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        
        message.deleted = true;
        message.deletedBy = req.user.username;
        message.updatedAt = Date.now();
        await message.save();
        
        res.json({ message: 'Message deleted' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/users', async (req, res) => {
    try {
        const users = await User.find({ isBanned: false })
            .select('username role profilePic customRoles')
            .sort({ username: 1 });
        res.json(users);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/custom-roles', authenticate, async (req, res) => {
    try {
        const roles = await CustomRole.find();
        res.json(roles);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/custom-roles', authenticate, isOwner, async (req, res) => {
    try {
        const { name, color } = req.body;
        
        const role = new CustomRole({
            name,
            color: color || '#00f2ff',
            createdBy: req.user._id
        });
        
        await role.save();
        res.json(role);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/custom-roles/:roleId/assign', authenticate, isOwner, async (req, res) => {
    try {
        const { userId } = req.body;
        const role = await CustomRole.findById(req.params.roleId);
        
        if (!role.users.includes(userId)) {
            role.users.push(userId);
            await role.save();
            
            await User.findByIdAndUpdate(userId, {
                $push: {
                    customRoles: {
                        roleId: role._id,
                        name: role.name,
                        color: role.color
                    }
                }
            });
        }
        
        res.json(role);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/admin/role', authenticate, isOwner, async (req, res) => {
    try {
        const { userId, role } = req.body;
        const user = await User.findByIdAndUpdate(
            userId,
            { role },
            { new: true }
        ).select('-password -__v -chatHistory');
        res.json(user);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/admin/balance', authenticate, isOwner, async (req, res) => {
    try {
        const { userId, amount } = req.body;
        const user = await User.findByIdAndUpdate(
            userId,
            { $inc: { balance: amount } },
            { new: true }
        ).select('-password -__v -chatHistory');
        res.json(user);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/admin/ban', authenticate, isOwner, async (req, res) => {
    try {
        const { userId, reason } = req.body;
        const user = await User.findByIdAndUpdate(
            userId,
            { isBanned: true },
            { new: true }
        ).select('-password -__v -chatHistory');
        
        res.json(user);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Cleanup expired sessions and verification codes
setInterval(() => {
    const now = Date.now();
    
    for (const [sessionId, session] of sessions.entries()) {
        if (now - session.createdAt > 7 * 24 * 60 * 60 * 1000) {
            sessions.delete(sessionId);
        }
    }
    
    for (const [key, data] of verificationCodes.entries()) {
        if (now > data.expires) {
            verificationCodes.delete(key);
        }
    }
}, 60000);

// Make uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`HEXploits running on http://localhost:${PORT}`);
    console.log('========================================');
    console.log('FIRST USER TO REGISTER BECOMES OWNER!');
    console.log('========================================');
});
