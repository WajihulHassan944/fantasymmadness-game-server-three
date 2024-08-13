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

app.use(express.json());
app.use(cors());

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

const userSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  email: String,
  phone: String,
  password: String,
  isChecked: Boolean,
  isSubscribed: Boolean,
  isUSCitizen: Boolean,
  isAgreed: Boolean,
  verificationToken: String,
  verified: { type: Boolean, default: false },
});

const User = mongoose.model('User', userSchema);

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
  const { firstName, lastName, email, phone, password } = req.body;

  // Generate a verification token
  const verificationToken = crypto.randomBytes(20).toString('hex');

  const newUser = new User({
    firstName,
    lastName,
    email,
    phone,
    password: await bcrypt.hash(password, 10),
    verificationToken,
    verified: false,
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


// Start server
const server = app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
