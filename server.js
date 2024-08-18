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

const fetch = require('node-fetch');


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
  BoxingMatch: {
    fighterOneStats: [{
      roundNumber: Number,
      HP: Number,
      BP: Number,
      TP: Number,
      RW: Number,
      RL: Number,
      KO: Number,
      SP: Number,
    }],
    fighterTwoStats: [{
      roundNumber: Number,
      HP: Number,
      BP: Number,
      TP: Number,
      RW: Number,
      RL: Number,
      KO: Number,
      SP: Number,
    }],
  },
  userPredictions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Reference to the user
    predictionStatus: { type: String, enum: ['submitted', 'notSubmitted'], default: 'notSubmitted' }
  }],
  __v: Number
});

const Match = mongoose.model('Match', matchSchema);

// DELETE API to delete a match by ID
app.delete('/api/matches/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deletedMatch = await Match.findByIdAndDelete(id);

    if (!deletedMatch) {
      return res.status(404).json({ message: 'Match not found' });
    }

    res.status(200).json({ message: 'Match deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

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

// Update user prediction status
app.post('/api/matches/:matchId/updatePredictionStatus', async (req, res) => {
  try {
    const { matchId } = req.params;
    const { userId, predictionStatus } = req.body;

    const match = await Match.findById(matchId);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    const userPrediction = match.userPredictions.find(pred => pred.userId.toString() === userId);

    if (userPrediction) {
      userPrediction.predictionStatus = predictionStatus;
    } else {
      match.userPredictions.push({ userId, predictionStatus });
    }

    await match.save();
    res.status(200).json({ message: 'Prediction status updated successfully' });
  } catch (error) {
    console.error('Error updating prediction status:', error);
    res.status(500).json({ message: 'Failed to update prediction status' });
  }
});



app.post('/match/addRoundResults/:id', async (req, res) => {
  const { id } = req.params;
  const { fighterOneStats, fighterTwoStats } = req.body;

  try {
    // Find the match document
    const match = await Match.findById(id);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    // Update round results for Fighter One
    const existingFighterOneRoundIndex = match.BoxingMatch.fighterOneStats.findIndex(stat => stat.roundNumber === fighterOneStats.roundNumber);
    if (existingFighterOneRoundIndex !== -1) {
      match.BoxingMatch.fighterOneStats[existingFighterOneRoundIndex] = fighterOneStats;
    } else {
      match.BoxingMatch.fighterOneStats.push(fighterOneStats);
    }

    // Update round results for Fighter Two
    const existingFighterTwoRoundIndex = match.BoxingMatch.fighterTwoStats.findIndex(stat => stat.roundNumber === fighterTwoStats.roundNumber);
    if (existingFighterTwoRoundIndex !== -1) {
      match.BoxingMatch.fighterTwoStats[existingFighterTwoRoundIndex] = fighterTwoStats;
    } else {
      match.BoxingMatch.fighterTwoStats.push(fighterTwoStats);
    }

    // Save the updated match document
    await match.save();

    res.status(200).json({ message: 'Round results added successfully', match });
  } catch (error) {
    console.error('Error adding round results:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
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
  const {
    firstName, lastName, playerName, email, phone, password, zipCode,
    isNotificationsEnabled, isSubscribed, isUSCitizen, isAgreed
  } = req.body;

  // Generate a verification token
  const verificationToken = crypto.randomBytes(20).toString('hex');

  const newUser = new User({
    firstName, lastName, playerName, email, phone, zipCode,
    isNotificationsEnabled, isSubscribed, isUSCitizen, isAgreed,
    verified: false, verificationToken,
    password: await bcrypt.hash(password, 10),
  });

  await newUser.save();

  // Send verification email
  const verificationLink = `https://fantasymmadness-game-server-three.vercel.app/verify-email?token=${verificationToken}`;
  const mailOptions = {
    from: 'vascularbundle43@gmail.com',
    to: email,
    subject: 'Email Verification',
    html: `
      <p>Thank you for registering with us. Please click the button below to verify your email address:</p>
      <a href="${verificationLink}" 
         style="background-color: #720e0c;
                margin-top: 10px;
                padding: 15px 30px;
                text-align: center;
                text-transform: uppercase;
                transition: 0.5s;
                color: white;
                font-size: 25px;
                border-radius: 10px;
                text-decoration: none;"
         id="verifyButton">
         Verify Email
      </a>
      <script>
        document.getElementById('verifyButton').addEventListener('click', function(event) {
          event.preventDefault(); // Prevent the default link behavior
          fetch('${verificationLink}')
            .then(response => response.text())
            .then(data => {
              this.innerText = 'Verified';
              this.style.backgroundColor = '#38b90c'; // Change button color to green
            })
            .catch(error => console.error('Error:', error));
        });
      </script>
    `
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
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    if (!user.verified) {
      return res.status(403451).json({ message: 'Please verify your email before logging in' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '1h' });

    res.cookie('token', token, { httpOnly: true, maxAge: 3600000 }); // 1 hour

    res.status(200).json({
      message: 'Login successful',
      token,  // Return token in response body
      user: {
        id: user._id,
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
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});


const verifyToken = (req, res, next) => {
  console.log('Request headers:', req.headers); // Debugging line
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Extract token from Bearer scheme

  if (token == null) return res.sendStatus(401); // No token, unauthorized

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403); // Token invalid, forbidden

    req.user = user; // Attach user info to request object
    next();
  });
};


// Profile API
app.get('/profile', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({ user });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});












































const scoreSchema = new mongoose.Schema({
  playerId: String,
  matchId: String,
  predictions: [{ 
    round: Number, 
    hpPrediction1: Number, 
    bpPrediction1: Number, 
    hpPrediction2: Number, 
    bpPrediction2: Number, 
    tpPrediction1: Number, 
    tpPrediction2: Number, 
    rwPrediction1: Number, 
    rwPrediction2: Number, 
    koPrediction1: Number, 
    koPrediction2: Number 
  }],
});

const Score = mongoose.model('Score', scoreSchema);

app.post('/api/scores', async (req, res) => {
  try {
    const { playerId, matchId, predictions } = req.body;

    // Check if there's an existing record with the same playerId and matchId
    let existingScore = await Score.findOne({ playerId, matchId });

    if (existingScore) {
      // If a record exists, update its values
      existingScore.predictions = predictions;
      await existingScore.save();
      res.status(200).send(existingScore);
    } else {
      // If no record exists, create a new one
      const score = new Score({ playerId, matchId, predictions });
      await score.save();
      res.status(201).send(score);
    }
  } catch (error) {
    res.status(400).send(error);
  }
});

// API endpoint to retrieve scores
app.get('/api/scores', async (req, res) => {
  try {
    const scores = await Score.find();
    res.send(scores);
  } catch (error) {
    res.status(500).send(error);
  }
});

app.delete('/api/scores', async (req, res) => {
  try {
    await Score.deleteMany({}); // This will delete all records in the Score collection
    res.status(200).send({ message: 'All records deleted successfully' });
  } catch (error) {
    res.status(500).send({ error: 'Failed to delete records' });
  }
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
