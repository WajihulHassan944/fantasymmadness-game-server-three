const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const app = express();
const { ObjectId } = require('mongodb');
const cors = require("cors");
const FormData = require('form-data');
const multer = require('multer');
const bcrypt = require('bcrypt');
const crypto = require('crypto'); // For generating the verification token
const nodemailer = require('nodemailer'); // For sending emails
const jwt = require('jsonwebtoken');
app.use(express.json());


// CORS configuration
const allowedOrigins = [
  'https://fantasymmadness-version2.vercel.app', // Production
  'http://localhost:3000' // Development
];

app.use(cors({
  origin: function (origin, callback) {
    if (allowedOrigins.includes(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // Allow credentials (cookies, headers, etc.)
}));

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// File upload configuration
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Match Schema
const matchSchema = new mongoose.Schema({
  matchCategory: String,
  matchName: String,
  matchFighterA: String,
  matchFighterB: String,
  matchDescription: String,
  matchVideoUrl: String,
  matchDate: Date,
  matchTime: String,  // Store the match time as a string in 'HH:MM' format
  matchTokens: Number,
  matchStatus: String,
  pot: Number,
  fighterAImage: String,  // URL of Fighter A's image
  fighterBImage: String,  // URL of Fighter B's image
  matchType: String,      // LIVE or SHADOW
});

const Match = mongoose.model('Match', matchSchema);

// Add Match API
app.post('/addMatch', upload.fields([{ name: 'fighterAImage' }, { name: 'fighterBImage' }]), async (req, res) => {
  const formDataA = new FormData();
  const formDataB = new FormData();
  const { default: fetch } = await import('node-fetch');

  // Upload Fighter A image
  formDataA.append('image', req.files.fighterAImage[0].buffer.toString('base64'));
  const responseA = await fetch('https://api.imgbb.com/1/upload?key=368cbdb895c5bed277d50d216adbfa52', {
    method: 'POST',
    body: formDataA,
  });
  const dataA = await responseA.json();
  const fighterAImageUrl = dataA.data.url;

  // Upload Fighter B image
  formDataB.append('image', req.files.fighterBImage[0].buffer.toString('base64'));
  const responseB = await fetch('https://api.imgbb.com/1/upload?key=368cbdb895c5bed277d50d216adbfa52', {
    method: 'POST',
    body: formDataB,
  });
  const dataB = await responseB.json();
  const fighterBImageUrl = dataB.data.url;

  const { matchCategory, matchName, matchFighterA, matchFighterB, matchDescription, matchVideoUrl, matchDate, matchTime, matchTokens, matchStatus, pot, matchType } = req.body;

  // Save the match details to the database
  const newMatch = new Match({
    matchCategory,
    matchName,
    matchFighterA,
    matchFighterB,
    matchDescription,
    matchVideoUrl,
    matchDate,
    matchTime,
    matchTokens,
    matchStatus,
    pot,
    fighterAImage: fighterAImageUrl,
    fighterBImage: fighterBImageUrl,
    matchType,
  });

  await newMatch.save();
  res.status(200).send('Match Added Successfully');
});

// Delete Match API
app.delete('/matchtodelete/:id', async (req, res) => {
  const { id } = req.params;
  console.log('Received DELETE request for Match ID:', id);
  try {
    const match = await Match.findByIdAndDelete(id);
    
    res.status(200).json({ message: 'Match deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get Matches API
app.get('/match', async (req, res) => {
  const match = await Match.find();
  res.send(match);
});















const userSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  playerName: String,
  zipCode: String,
  email: String,
  phone: String,
  password: String,
  isNotificationsEnabled: Boolean,
  isSubscribed: Boolean,
  isUSCitizen: Boolean,
  isAgreed: Boolean,
  verificationToken: String,
  verified: { type: Boolean, default: false },
  profileUrl: String, // Add profileUrl field
});

const User = mongoose.model('User', userSchema);


// Get Matches API
app.get('/users', async (req, res) => {
  const match = await User.find();
  res.send(match);
});


// Create reusable transporter object using the default SMTP transport
const transporter = nodemailer.createTransport({
  service: 'Gmail',
  auth: {
    user: 'vascularbundle43@gmail.com',
    pass: 'gxauudkzvdvhdzbg',
  },
});

app.post('/register', async (req, res) => {
  const { firstName, lastName,playerName, email, phone, password , zipCode,
    isNotificationsEnabled,
    isSubscribed,
    isUSCitizen,
    isAgreed} = req.body;

  // Generate a verification token
  const verificationToken = crypto.randomBytes(20).toString('hex');

  const newUser = new User({
    firstName,
    lastName,
    playerName,
    email,
    phone,
    zipCode,
    isNotificationsEnabled,
    isSubscribed,
    isUSCitizen,
    isAgreed,
    verified: false,
    verificationToken,
    password: await bcrypt.hash(password, 10),
    
  });

  await newUser.save();

  // Send verification email
  const verificationLink = `https://fantasymmadness-game-server-three.vercel.app/verify-email?token=${verificationToken}`;
  const mailOptions = {
    from: 'vascularbundle43@gmail.com',
    to: email,
    subject: 'Email Verification',
    html: `<p>Thank you for registering with us. Please click the link below to verify your email address:</p>
           <a href="${verificationLink}">Verify Email</a>`
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return res.status(500).send('Error sending verification email');
    } else {
      res.status(200).send('Registration successful! Please check your email to verify your account.');
    }
  });
});

app.get('/verify-email', async (req, res) => {
  const { token } = req.query;

  const user = await User.findOne({ verificationToken: token });

  if (!user) {
    return res.status(400).send('Invalid or expired token');
  }

  user.verified = true;
  user.verificationToken = null; // Clear the token after verification
  await user.save();

  res.status(200).send('Email verified successfully!');
});
// Default route
app.get("/", (req, res) =>{
  res.send("Backend server has started running successfully...");
});



// Delete Match API
app.delete('/usertodelete/:id', async (req, res) => {
  const { id } = req.params;
  console.log('Received DELETE request for User ID:', id);
  try {
    const user = await User.findByIdAndDelete(id);
    
    res.status(200).json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get user details by email (for checking verification status)
app.get('/user/:email', async (req, res) => {
  const { email } = req.params;
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).send('User not found');
    }
    res.json({ verified: user.verified });
  } catch (error) {
    res.status(500).send('Internal server error');
  }
});




app.post('/upload-avatar', upload.single('image'), async (req, res) => {
  const formData = new FormData();
  const { default: fetch } = await import('node-fetch');
  
  // Upload Avatar image
  formData.append('image', req.file.buffer.toString('base64'));
  const response = await fetch('https://api.imgbb.com/1/upload?key=368cbdb895c5bed277d50d216adbfa52', {
    method: 'POST',
    body: formData,
  });
  
  const data = await response.json();
  const avatarUrl = data.data.url;

  // Update user profile with avatar URL
  const { email } = req.body;
  await User.findOneAndUpdate({ email }, { profileUrl: avatarUrl });

  res.status(200).send('Avatar uploaded and saved successfully');
});

















const JWT_SECRET = 'asdfghjklmnbvcdewsdfgbnvcfdx'; 

// Login API
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    // Find user by email
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    // Check if the user is verified
    if (!user.verified) {
      return res.status(403).json({ message: 'Please verify your email before logging in' });
    }

    // Compare the provided password with the stored hashed password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    // Create a JWT token valid for 1 hour
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '1h' });

    // Set the JWT as a cookie
    res.cookie('token', token, { httpOnly: true, maxAge: 3600000 }); // 1 hour

    res.status(200).json({ message: 'Login successful' });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get user details by ID
app.get('/user/:id', async (req, res) => {
  const { id } = req.params;
  
  console.log('Received ID:', id); // Log the received ID

  try {
    // Find user by ID
    const user = await User.findById(id);
    
    console.log('User found:', user); // Log the user object

    if (!user) {
      return res.status(404).send('User not found');
    }
    
    res.json({
      firstName: user.firstName,
      lastName: user.lastName,
      playerName: user.playerName,
      zipCode: user.zipCode,
      email: user.email,
      phone: user.phone,
      isNotificationsEnabled: user.isNotificationsEnabled,
      isSubscribed: user.isSubscribed,
      isUSCitizen: user.isUSCitizen,
      isAgreed: user.isAgreed,
      profileUrl: user.profileUrl,
      verified: user.verified,
    });
  } catch (error) {
    console.error('Error fetching user:', error); // Log the error
    res.status(500).send('Internal server error');
  }
});



// Start server
const server = app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
