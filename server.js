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

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const { promisify } = require('util');


const fetch = require('node-fetch');


app.use(express.json());


// CORS configuration
const allowedOrigins = [
  'https://fantasymmadness-version2.vercel.app', // Production
  'http://localhost:3000',
  'https://www.fantasymmadness.com'
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
const shadowSchema = new mongoose.Schema({
  matchCategory: String, // 'boxing' or 'mma'
  matchCategoryTwo: String,
  matchName: String,
  matchFighterA: String,
  matchFighterB: String,
  matchDescription: String,
  matchVideoUrl: String,
  fighterAImage: String,  // URL of Fighter A's image
  fighterBImage: String,  // URL of Fighter B's image
  matchType: String,      // LIVE or SHADOW
  maxRounds: Number,
  fighterAImageDeleteUrl: String, // ImgBB delete URL for Fighter A's image
  fighterBImageDeleteUrl: String, 
  matchStatus: { type: String, enum: ['Finished', 'Ongoing'], default: 'Ongoing' },
  
  // Boxing-specific stats
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

  // MMA-specific stats
  MMAMatch: {
    fighterOneStats: [{
      roundNumber: Number,
      ST: Number,
      KI: Number,
      KN: Number,
      EL: Number,
      RW: Number,
      RL: Number,
      KO: Number,
      SP: Number,
   }],
    fighterTwoStats: [{
      roundNumber: Number,
      ST: Number,
      KI: Number,
      KN: Number,
      EL: Number,
      RW: Number,
      RL: Number,
      KO: Number,
      SP: Number,
   }],
  },

  // Add AffiliateIds as an array of objects
  AffiliateIds: [
    {
      AffiliateId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Affiliate', // Reference to the Affiliate schema
      },
      matchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Match', // Reference to the Match schema (or appropriate schema for matches)
      }
    }
  ]
});



const Shadow = mongoose.model('Shadow', shadowSchema);


app.post('/finishShadow/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;

    // Find the match by ID and update the status to 'Finished'
    const match = await Shadow.findByIdAndUpdate(
      matchId, 
      { matchStatus: 'Finished' }, 
      { new: true } // This option returns the updated document
    );

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    res.json({ message: 'Match status updated to Finished', match });
  } catch (error) {
    console.error('Error finishing match:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


app.post('/shadow/addShadowRoundResults/:id', async (req, res) => {
  const { id } = req.params;
  const { fighterOneStats, fighterTwoStats } = req.body;

  try {
    // Find the match document
    const match = await Shadow.findById(id);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    // Determine the category of the match
    if (match.matchCategory === 'boxing') {
      // Update round results for Fighter One (Boxing)
      const existingFighterOneRoundIndex = match.BoxingMatch.fighterOneStats.findIndex(stat => stat.roundNumber === fighterOneStats.roundNumber);
      if (existingFighterOneRoundIndex !== -1) {
        match.BoxingMatch.fighterOneStats[existingFighterOneRoundIndex] = fighterOneStats;
      } else {
        match.BoxingMatch.fighterOneStats.push(fighterOneStats);
      }

      // Update round results for Fighter Two (Boxing)
      const existingFighterTwoRoundIndex = match.BoxingMatch.fighterTwoStats.findIndex(stat => stat.roundNumber === fighterTwoStats.roundNumber);
      if (existingFighterTwoRoundIndex !== -1) {
        match.BoxingMatch.fighterTwoStats[existingFighterTwoRoundIndex] = fighterTwoStats;
      } else {
        match.BoxingMatch.fighterTwoStats.push(fighterTwoStats);
      }
    } else if (match.matchCategory === 'mma') {
      // Update round results for Fighter One (MMA)
      const existingFighterOneRoundIndex = match.MMAMatch.fighterOneStats.findIndex(stat => stat.roundNumber === fighterOneStats.roundNumber);
      if (existingFighterOneRoundIndex !== -1) {
        match.MMAMatch.fighterOneStats[existingFighterOneRoundIndex] = fighterOneStats;
      } else {
        match.MMAMatch.fighterOneStats.push(fighterOneStats);
      }

      // Update round results for Fighter Two (MMA)
      const existingFighterTwoRoundIndex = match.MMAMatch.fighterTwoStats.findIndex(stat => stat.roundNumber === fighterTwoStats.roundNumber);
      if (existingFighterTwoRoundIndex !== -1) {
        match.MMAMatch.fighterTwoStats[existingFighterTwoRoundIndex] = fighterTwoStats;
      } else {
        match.MMAMatch.fighterTwoStats.push(fighterTwoStats);
      }
    } else {
      return res.status(400).json({ message: 'Invalid match category' });
    }

    // Save the updated match document
    await match.save();

    res.status(200).json({ message: 'Round results added successfully', match });
  } catch (error) {
    console.error('Error adding round results:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});





app.post('/updateShadowVideo', async (req, res) => {
  const { matchId, matchVideoUrl } = req.body;

  // Basic validation
  if (!matchId || !matchVideoUrl) {
    return res.status(400).json({ message: 'matchId and matchVideoUrl are required' });
  }

  try {
    // Find the match by matchId and update the matchVideoUrl if it exists, otherwise create a new one
    const updatedMatch = await Shadow.findOneAndUpdate(
      { _id: matchId }, 
      { matchVideoUrl }, // Update the matchVideoUrl
      { new: true, upsert: true } // new: return the updated document, upsert: create if not found
    );

    res.status(200).json({
      message: 'Match video URL updated successfully',
      updatedMatch,
    });
  } catch (error) {
    console.error('Error updating match:', error);
    res.status(500).json({ message: 'An error occurred while updating the match' });
  }
});

app.delete('/shadowfighttodelete/:id', async (req, res) => {
  const { id } = req.params;
  console.log('Received DELETE request for Shadow ID:', id);

  try {
    // Fetch the shadow fight by ID
    const shadowFight = await Shadow.findById(id);
    
    if (!shadowFight) {
      return res.status(404).json({ message: 'Shadow fight not found' });
    }

    const { fighterAImageDeleteUrl, fighterBImageDeleteUrl } = shadowFight;

    // Delete Fighter A image from ImgBB
    if (fighterAImageDeleteUrl) {
      await fetch(fighterAImageDeleteUrl, { method: 'DELETE' });
    }

    // Delete Fighter B image from ImgBB
    if (fighterBImageDeleteUrl) {
      await fetch(fighterBImageDeleteUrl, { method: 'DELETE' });
    }

    // Delete the shadow fight from the database
    await Shadow.findByIdAndDelete(id);

    res.status(200).json({ message: 'Shadow fight and associated images deleted successfully' });
  } catch (error) {
    console.error('Error deleting shadow fight:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


app.post('/addShadow', upload.fields([{ name: 'fighterAImage' }, { name: 'fighterBImage' }]), async (req, res) => {
  const formDataA = new FormData();
  const formDataB = new FormData();
  const { default: fetch } = await import('node-fetch');

  let fighterAImageUrl, fighterBImageUrl, fighterAImageDeleteUrl, fighterBImageDeleteUrl;

  // Upload Fighter A image
  if (req.files.fighterAImage) {
    formDataA.append('image', req.files.fighterAImage[0].buffer.toString('base64'));
    const responseA = await fetch('https://api.imgbb.com/1/upload?key=368cbdb895c5bed277d50d216adbfa52', {
      method: 'POST',
      body: formDataA,
    });
    const dataA = await responseA.json();
    fighterAImageUrl = dataA.data.url;            // Store Fighter A image URL
    fighterAImageDeleteUrl = dataA.data.delete_url; // Store Fighter A delete URL
  }

  // Upload Fighter B image
  if (req.files.fighterBImage) {
    formDataB.append('image', req.files.fighterBImage[0].buffer.toString('base64'));
    const responseB = await fetch('https://api.imgbb.com/1/upload?key=368cbdb895c5bed277d50d216adbfa52', {
      method: 'POST',
      body: formDataB,
    });
    const dataB = await responseB.json();
    fighterBImageUrl = dataB.data.url;            // Store Fighter B image URL
    fighterBImageDeleteUrl = dataB.data.delete_url; // Store Fighter B delete URL
  }

  const { matchCategoryTwo, maxRounds, matchCategory, matchName, matchFighterA, matchFighterB, matchDescription, matchVideoUrl, matchType } = req.body;

  // Save the match details to the database
  const newMatch = new Shadow({
    matchCategory,
    matchCategoryTwo,
    matchName,
    matchFighterA,
    matchFighterB,
    matchDescription,
    matchVideoUrl,
    fighterAImage: fighterAImageUrl,
    fighterBImage: fighterBImageUrl,
    fighterAImageDeleteUrl, // Store Fighter A delete URL in the database
    fighterBImageDeleteUrl, // Store Fighter B delete URL in the database
    matchType,
    maxRounds,
  });

  await newMatch.save();
  res.status(200).json({ message: 'Match Added Successfully and Notifications Sent', matchId: newMatch._id });
});



// Get Matches API
app.get('/shadow', async (req, res) => {
  const match = await Shadow.find();
  res.send(match);
});




const matchSchema = new mongoose.Schema({
  matchCategory: String, // 'boxing' or 'mma'
  matchCategoryTwo: String,
  affiliateId: String,
  shadowFightId: String,
  matchName: String,
  matchFighterA: String,
  matchFighterB: String,
  matchDescription: String,
  matchBy: { type: String, enum: ['admin', 'affiliate'], default: 'admin' },
  matchStatus: { type: String, enum: ['Finished', 'Ongoing'], default: 'Ongoing' },
  matchReward: { type: String, enum: ['Rewarded', 'NotRewarded'], default: 'NotRewarded' },
  matchVideoUrl: String,
  matchDate: Date,
  matchTime: String,  // Store the match time as a string in 'HH:MM' format
  matchTokens: Number,
  pot: Number,
  profit: Number,
  amountOverPotBudget: Number,
  fighterAImage: String,  // URL of Fighter A's image
  fighterBImage: String,  // URL of Fighter B's image
  matchType: String,      // LIVE or SHADOW
  maxRounds: Number,
  fighterAImageDeleteUrl: String,
  fighterBImageDeleteUrl: String,

  // Boxing-specific stats
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

  // MMA-specific stats
  MMAMatch: {
    fighterOneStats: [{
      roundNumber: Number,
      ST: Number,
      KI: Number,
      KN: Number,
      EL: Number,
      RW: Number,
      RL: Number,
      KO: Number,
      SP: Number,
   }],
    fighterTwoStats: [{
      roundNumber: Number,
      ST: Number,
      KI: Number,
      KN: Number,
      EL: Number,
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

app.get('/matchByName', async (req, res) => {
  const { matchName } = req.query;

  if (!matchName) {
      return res.status(400).json({ error: 'Match name is required.' });
  }

  try {
      const match = await Match.findOne({ matchName });

      if (!match) {
          return res.status(404).json({ message: 'Match not found' });
      }

      res.status(200).json(match);
  } catch (error) {
      console.error('Error fetching match details:', error);
      res.status(500).json({ message: 'Server error' });
  }
});




// POST API to receive matchId and matchVideoUrl
app.post('/updateMatchVideo', async (req, res) => {
  const { matchId, matchVideoUrl } = req.body;

  // Basic validation
  if (!matchId || !matchVideoUrl) {
    return res.status(400).json({ message: 'matchId and matchVideoUrl are required' });
  }

  try {
    // Find the match by matchId and update the matchVideoUrl if it exists, otherwise create a new one
    const updatedMatch = await Match.findOneAndUpdate(
      { _id: matchId }, 
      { matchVideoUrl }, // Update the matchVideoUrl
      { new: true, upsert: true } // new: return the updated document, upsert: create if not found
    );

    res.status(200).json({
      message: 'Match video URL updated successfully',
      updatedMatch,
    });
  } catch (error) {
    console.error('Error updating match:', error);
    res.status(500).json({ message: 'An error occurred while updating the match' });
  }
});



app.post('/finishMatch/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;

    // Find the match by ID and update the status to 'Finished'
    const match = await Match.findByIdAndUpdate(
      matchId, 
      { matchStatus: 'Finished' }, 
      { new: true } // This option returns the updated document
    );

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    res.json({ message: 'Match status updated to Finished', match });
  } catch (error) {
    console.error('Error finishing match:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});
// GET API to retrieve a match by ID
app.get('/api/matches/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Find the match by ID
    const match = await Match.findById(id);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    res.status(200).json(match);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

app.delete('/api/matches/:id', async (req, res) => {
  try {
    const { id } = req.params; // matchId
    const { affiliateId } = req.query; // Get affiliateId from query parameters

    // Find the match to get image delete URLs
    const match = await Match.findById(id);
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    // Delete fighter images from ImgBB
    if (match.fighterAImageDeleteUrl) {
      await fetch(match.fighterAImageDeleteUrl, { method: 'DELETE' });
    }
    if (match.fighterBImageDeleteUrl) {
      await fetch(match.fighterBImageDeleteUrl, { method: 'DELETE' });
    }

    // Delete the match by ID
    const deletedMatch = await Match.findByIdAndDelete(id);
    if (!deletedMatch) {
      return res.status(404).json({ message: 'Match not found' });
    }

    // Delete the associated predictions
    await Score.deleteMany({ matchId: id });

    // Remove affiliateId and matchId combination from AffiliateIds
    if (affiliateId) {
      await Shadow.updateMany(
        { 'AffiliateIds.AffiliateId': affiliateId, 'AffiliateIds.matchId': id },
        { $pull: { AffiliateIds: { AffiliateId: affiliateId, matchId: id } } }
      );
    }

    res.status(200).json({ message: 'Match, associated predictions, and images deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});

app.post('/addMatch', upload.fields([{ name: 'fighterAImage' }, { name: 'fighterBImage' }]), async (req, res) => {
  const { default: fetch } = await import('node-fetch');
  const { BoxingMatch, MMAMatch, matchCategoryTwo, shadowFightId, maxRounds, affiliateId, matchBy, profit, amountOverPotBudget, matchCategory, matchName, matchFighterA, matchFighterB, matchDescription, matchVideoUrl, matchDate, matchTime, matchTokens, matchStatus, pot, matchType, fighterAImageUrl, fighterBImageUrl } = req.body;

  let fighterAImage, fighterBImage, fighterAImageDeleteUrl, fighterBImageDeleteUrl;

  // Use the image URLs directly if they are provided
  if (fighterAImageUrl && fighterBImageUrl) {
    fighterAImage = fighterAImageUrl;
    fighterBImage = fighterBImageUrl;
  } else {
    // Handle image uploads if URLs are not provided
    if (req.files.fighterAImage) {
      const formDataA = new FormData();
      formDataA.append('image', req.files.fighterAImage[0].buffer.toString('base64'));
      const responseA = await fetch('https://api.imgbb.com/1/upload?key=368cbdb895c5bed277d50d216adbfa52', {
        method: 'POST',
        body: formDataA,
      });
      const dataA = await responseA.json();
      fighterAImage = dataA.data.url;
      fighterAImageDeleteUrl = dataA.data.delete_url;
    }

    if (req.files.fighterBImage) {
      const formDataB = new FormData();
      formDataB.append('image', req.files.fighterBImage[0].buffer.toString('base64'));
      const responseB = await fetch('https://api.imgbb.com/1/upload?key=368cbdb895c5bed277d50d216adbfa52', {
        method: 'POST',
        body: formDataB,
      });
      const dataB = await responseB.json();
      fighterBImage = dataB.data.url;
      fighterBImageDeleteUrl = dataB.data.delete_url;
    }
  }

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
    fighterAImage,
    fighterBImage,
    matchType,
    affiliateId,
    matchBy,
    profit,
    amountOverPotBudget,
    maxRounds,
    shadowFightId,
    matchCategoryTwo,
    fighterAImageDeleteUrl, // Save the delete URL for Fighter A
    fighterBImageDeleteUrl,
    BoxingMatch: JSON.parse(BoxingMatch),
    MMAMatch: JSON.parse(MMAMatch),
  });

  const savedMatch = await newMatch.save(); // Save the match and get the saved match

  // Now that match is saved, store affiliateId and matchId in the Shadow schema
  const shadowFight = await Shadow.findById(shadowFightId);
  if (shadowFight) {
    const affiliateExists = shadowFight.AffiliateIds.some(item => item.AffiliateId.toString() === affiliateId && item.matchId.toString() === savedMatch._id.toString());

    if (!affiliateExists) {
      shadowFight.AffiliateIds.push({
        AffiliateId: affiliateId,
        matchId: savedMatch._id,
      });
      await shadowFight.save();
    }
  }

  
// Create mailOptions with a hardcoded 'to' field
const mailOptions = {
  from: 'vascularbundle43@gmail.com',
  to: 'wajih786hassan@gmail.com', // Hardcoded email address
  subject: 'Fantasy mmadness',
  html: `
  <img src="https://www.fantasymmadness.com/static/media/logo.c2aa609dbe0ed6c1af42.png" style="width:100px; margin:auto;" />
  <p>Dear User,</p>
    <p>We are excited to announce a new match has been added:</p>
    <p><strong>Match Added:</strong> ${matchName}</p>
    <div style="display:flex; gap:20px;"> 
      <div style="display:flex; justify-content:center; flex-direction:column; align-items:center;"> 
        <div style="width:60px; height:60px; border-radius:50%; display:flex; justify-content:center; align-items:center; overflow:hidden; border:3px solid red; background-color:#fff;">
          <img src="${fighterAImage}" style="width:100%; object-fit:cover; border-radius:50%; height:100%;">
          <h5>${matchFighterA}</h5>
        </div>
      </div>
      <h1>Vs</h1>
      <div style="display:flex; justify-content:center; flex-direction:column; align-items:center;"> 
        <div style="width:60px; height:60px; border-radius:50%; display:flex; justify-content:center; align-items:center; overflow:hidden; border:3px solid blue; background-color:#fff;">
          <img src="${fighterBImage}" style="width:100%; object-fit:cover; border-radius:50%; height:100%;">
          <h5>${matchFighterB}</h5>
        </div>
      </div>
    </div>
    <p><strong>Date:</strong> ${matchDate}</p>
    <p><strong>Time:</strong> ${matchTime}</p>
    <p><strong>Max Rounds:</strong> ${maxRounds}</p>
    <p><strong>Match Types:</strong> ${matchType}</p>
    <a href="https://fantasymmadness.com/upcomingfights">Click here</a> to get more details
    <img src="https://www.fantasymmadness.com/static/media/logo.c2aa609dbe0ed6c1af42.png" style="width:100px; margin:auto;" />
     <a href="https://fantasymmadness.com">https://fantasymmadness.com</a>
   `,

};

// Send the email
try {
  await transporter.sendMail(mailOptions);
  console.log('Email sent successfully');
} catch (error) {
  console.error('Error sending email:', error);
}



  // Respond with success and the saved match ID
  res.status(200).json({ message: 'Match Added Successfully and Notifications Sent', matchId: savedMatch._id });
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

    // Determine the category of the match
    if (match.matchCategory === 'boxing') {
      // Update round results for Fighter One (Boxing)
      const existingFighterOneRoundIndex = match.BoxingMatch.fighterOneStats.findIndex(stat => stat.roundNumber === fighterOneStats.roundNumber);
      if (existingFighterOneRoundIndex !== -1) {
        match.BoxingMatch.fighterOneStats[existingFighterOneRoundIndex] = fighterOneStats;
      } else {
        match.BoxingMatch.fighterOneStats.push(fighterOneStats);
      }

      // Update round results for Fighter Two (Boxing)
      const existingFighterTwoRoundIndex = match.BoxingMatch.fighterTwoStats.findIndex(stat => stat.roundNumber === fighterTwoStats.roundNumber);
      if (existingFighterTwoRoundIndex !== -1) {
        match.BoxingMatch.fighterTwoStats[existingFighterTwoRoundIndex] = fighterTwoStats;
      } else {
        match.BoxingMatch.fighterTwoStats.push(fighterTwoStats);
      }
    } else if (match.matchCategory === 'mma') {
      // Update round results for Fighter One (MMA)
      const existingFighterOneRoundIndex = match.MMAMatch.fighterOneStats.findIndex(stat => stat.roundNumber === fighterOneStats.roundNumber);
      if (existingFighterOneRoundIndex !== -1) {
        match.MMAMatch.fighterOneStats[existingFighterOneRoundIndex] = fighterOneStats;
      } else {
        match.MMAMatch.fighterOneStats.push(fighterOneStats);
      }

      // Update round results for Fighter Two (MMA)
      const existingFighterTwoRoundIndex = match.MMAMatch.fighterTwoStats.findIndex(stat => stat.roundNumber === fighterTwoStats.roundNumber);
      if (existingFighterTwoRoundIndex !== -1) {
        match.MMAMatch.fighterTwoStats[existingFighterTwoRoundIndex] = fighterTwoStats;
      } else {
        match.MMAMatch.fighterTwoStats.push(fighterTwoStats);
      }
    } else {
      return res.status(400).json({ message: 'Invalid match category' });
    }

    // Save the updated match document
    await match.save();

    res.status(200).json({ message: 'Round results added successfully', match });
  } catch (error) {
    console.error('Error adding round results:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

















































// Encryption function
const encrypt = async (text) => {
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync('encryption-password', 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    content: encrypted.toString('hex'),
    tag: tag.toString('hex'),
  };
};

// Decryption function
const decrypt = async (hash) => {
  const key = crypto.scryptSync('encryption-password', 'salt', 32);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(hash.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(hash.tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(hash.content, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString();
};



const userSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  playerName: String,
  zipCode: String,
  tokens: String,
  email: String,
  phone: String,
  shortBio: String,
  password: String,
  isNotificationsEnabled: Boolean,
  isSubscribed: Boolean,
  isUSCitizen: Boolean,
  isAgreed: Boolean,
  verificationToken: String,
  verified: { type: Boolean, default: false },
  profileUrl: String,
  currentPlan: { type: String, default: 'None' }, // Current subscription plan
  freePlanExpiryDate: Date, // Date when the free plan expires
  hasAvailedFreePlan: { type: Boolean, default: false }, // Indicates if the user has availed the free plan
  preferredPaymentMethod: String, 
  preferredPaymentMethodValue: String, 
  billing: {
    cardNumber: {
      iv: String,
      content: String,
      tag: String,
    },
    expMonth: String,
    expYear: String,
    cvc: {
      iv: String,
      content: String,
      tag: String,
    },
    billingAddress: {
      line1: String,
      city: String,
      state: String,
      postalCode: String,
    },
    stripeCustomerId: String, // Stripe customer ID reference
  },
}, { timestamps: true }); 

const User = mongoose.model('User', userSchema);


app.post('/user/updatePayment/:id', async (req, res) => {
  const { id } = req.params; // Get the affiliate ID from URL params
  const { preferredPaymentMethod, preferredPaymentMethodValue } = req.body; // Get data from request body

  try {
    // Find the affiliate by ID and update the payment method and value
    const updatedUser = await User.findByIdAndUpdate(
      id, 
      {
        preferredPaymentMethod,
        preferredPaymentMethodValue
      }, 
      { new: true } // Return the updated document
    );

    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({ message: 'Affiliate updated successfully', data: updatedUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error });
  }
});



app.put('/update-profile/:userId', async (req, res) => {
  const { userId } = req.params;
  const { firstName, lastName, playerName, phone, zipCode, shortBio } = req.body;

  try {
      // Create an object to hold the fields that should be updated
      const updateFields = {};

      if (firstName) updateFields.firstName = firstName;
      if (lastName) updateFields.lastName = lastName;
      if (playerName) updateFields.playerName = playerName;
      if (phone) updateFields.phone = phone;
      if (zipCode) updateFields.zipCode = zipCode;
      if (shortBio) updateFields.shortBio = shortBio;

      // Update the user document with the specified fields
      const updatedUser = await User.findByIdAndUpdate(userId, updateFields, { new: true });

      if (!updatedUser) {
          return res.status(404).send('User not found');
      }

      res.status(200).json({
          message: 'Profile updated successfully',
          user: updatedUser
      });
  } catch (error) {
      console.error('Error updating profile:', error);
      res.status(500).send('Server error');
  }
});

// POST API to reward tokens to the user and update matchReward status
app.post('/api/reward-tokens/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { tokens, matchId } = req.body;

    // Find the user by ID
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add tokens to the user's account
    user.tokens = parseInt(user.tokens, 10) + parseInt(tokens, 10);

    // Save the updated user
    await user.save();

    // Update the match's reward status to "Rewarded"
    const match = await Match.findById(matchId);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    match.matchReward = 'Rewarded';

    // Save the updated match
    await match.save();

    res.status(200).json({ success: true, message: 'Tokens rewarded and match updated successfully', user, match });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error });
  }
});


app.post('/api/deduct-tokens', async (req, res) => {
  try {
    const { userId, matchTokens } = req.body;

    // Find the user by ID
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if the user has enough tokens
    if (user.tokens < matchTokens) {
      return res.status(400).json({ message: 'Insufficient tokens' });
    }

    // Deduct the tokens
    user.tokens -= matchTokens;
    await user.save();

    return res.status(200).json({ message: 'Tokens deducted successfully', tokensRemaining: user.tokens });
  } catch (error) {
    console.error('Error deducting tokens:', error);
    return res.status(500).json({ message: 'Server error' });
  }
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
    pass: 'mgopragxyqdftxig',
  },
});


// Contact form endpoint
app.post('/contact-us-fantasymmadness', (req, res) => {
  const { fullName, email, subject, message } = req.body;

  // Validate input (basic validation)
  if (!fullName || !email || !message) {
      return res.status(400).json({ error: 'Full name, email, and message are required.' });
  }

  const mailOptions = {
      from: email,
      to: 'vascularbundle43@gmail.com', // Using your email address to receive the message
      subject: `Contact Form Submission: ${subject}`,
      text: `Message from ${fullName} (${email}):\n\n${message}`,
  };

  transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
          console.error('Error sending email:', error);
          return res.status(500).json({ error: 'Failed to send email.' });
      }
      console.log('Email sent:', info.response);
      res.status(200).json({ message: 'Email sent successfully.' });
  });
});


app.post('/send-emails-to-all-users', async (req, res) => {
  const { emails, subject, message } = req.body;

  if (!emails || emails.length === 0) {
    return res.status(400).json({ error: 'No email addresses provided.' });
  }

  try {
    // Loop through each email and send the message
    for (let email of emails) {
      await transporter.sendMail({
        from: '"Fantasy MMAdness" <vascularbundle43@gmail.com>', // sender address
        to: email, // receiver email
        subject: subject, // subject line
        text: message, // plain text body
      });
    }

    res.status(200).json({ success: true, message: 'Emails sent successfully!' });
  } catch (error) {
    console.error('Error sending emails:', error);
    res.status(500).json({ error: 'Failed to send emails.' });
  }
});



app.post('/register', async (req, res) => {
  const { firstName, lastName, playerName, email, phone, password, zipCode,
    isNotificationsEnabled,
    isSubscribed,
    isUSCitizen,
    isAgreed } = req.body;

  // Check if email already exists
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return res.status(400).send('Email already registered');
  }

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

  setTimeout(async () => {
    // Find the user again to ensure the data is still available
    const user = await User.findOne({ email });
  
    if (user && !user.verified) {
      // Send failure notification email
      console.log('Attempting to send failure email...');
      const failureMailOptions = {
        from: 'vascularbundle43@gmail.com',
        to: email,
        subject: 'Verification Failed',
        html: `<p>Dear ${user.firstName},</p>
               <p>You have failed to verify your email within the required time. Your registration has been canceled.</p>
               <p>If this was a mistake, please register again.</p>`
      };
  
      transporter.sendMail(failureMailOptions, (error, info) => {
        if (error) {
          console.error('Error sending failure email:', error);
        } else {
          console.log('Failure email sent successfully:', info.response);
        }
      });
  
      // Delete the user after sending the email
      await User.deleteOne({ email });
      console.log(`User with email ${email} deleted due to unverified account.`);
    }
  }, 120000);
  
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


// Get user details by email (for checking verification status and returning additional user info)
app.get('/user/:email', async (req, res) => {
  const { email } = req.params;
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).send('User not found');
    }

    // Destructure necessary fields from the user object
    const { verified, firstName, lastName, playerName, phone, zipCode, profileUrl } = user;

    // Return the user information along with the verification status
    res.json({ 
      verified, 
      firstName, 
      lastName, 
      playerName, 
      phone, 
      zipCode,
      profileUrl 
    });
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

app.post('/user/:email/subscribe', async (req, res) => {
  const { email } = req.params;
  const { plan } = req.body;

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).send('User not found');
    }

    // Check if the user has already availed the free plan
    if (plan === 'Free') {
      if (user.hasAvailedFreePlan) {
        return res.status(400).json({ message: 'User has already availed the free plan' });
      }

      // Set the current plan to "Free", set the expiry date to one month from now, and allot 20 free tokens
      user.currentPlan = 'Free';
      user.freePlanExpiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 1 month from now
      user.hasAvailedFreePlan = true;
      user.tokens = '20'; // Allot 20 free tokens for the Free plan

    } else if (plan === 'Standard') {
      user.currentPlan = 'Standard';
      user.tokens = '100'; // Allot 100 free tokens for the Standard plan
    }

    await user.save();
    res.status(200).json({ message: 'Subscription updated successfully' });

  } catch (error) {
    console.error('Error updating subscription:', error);
    res.status(500).send('Internal server error');
  }
});


// Job to reset the current plan to "None" after the free plan expires
const cron = require('node-cron');


// Job to reset the current plan to "None" after the free plan expires
cron.schedule('0 0 * * *', async () => { // Runs daily at midnight
  const users = await User.find({
    currentPlan: 'Free',
    freePlanExpiryDate: { $lte: new Date() }
  });

  for (const user of users) {
    user.currentPlan = 'None';
    await user.save();
  }

  console.log('Expired free plans have been reset to "None"');
});






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

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.cookie('token', token, { httpOnly: true, maxAge: 3600000 }); // 1 hour

    res.status(200).json({
      message: 'Login successful',
      token,  // Return token in response body
      user: {
        id: user._id,
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

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
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


// Profile API
app.get('/profileAffiliate', verifyToken, async (req, res) => {
  try {
    const user = await Affiliate.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({ user });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});







































const affiliateSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  playerName: String,
  zipCode: String,
  email: String,
  phone: String,
  hearing: String,
  password: String,
  isNotificationsEnabled: Boolean,
  isSubscribed: Boolean,
  isUSCitizen: Boolean,
  isAgreed: Boolean,
  verified: { type: Boolean, default: false },
  profileUrl: String,
  preferredPaymentMethod: String, 
  preferredPaymentMethodValue: String, 
  usersJoined: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // User who joined
    email: String,  // Email of the user who joined
    joinedAt: { type: Date, default: Date.now } // Timestamp
  }],
}, { timestamps: true });


const Affiliate = mongoose.model('Affiliate', affiliateSchema);


app.get('/affiliateByName', async (req, res) => {
  const { fullName } = req.query;

  if (!fullName) {
      return res.status(400).json({ error: 'FullName is required.' });
  }

  try {
      // Assuming you have a model called Affiliate
      const affiliate = await Affiliate.findOne({
          $expr: { 
              $eq: [{ $concat: ["$firstName", " ", "$lastName"] }, fullName] 
          }
      });

      if (!affiliate) {
          return res.status(404).json({ message: 'Affiliate not found' });
      }

      res.status(200).json(affiliate);
  } catch (error) {
      console.error('Error fetching affiliate details:', error);
      res.status(500).json({ message: 'Server error' });
  }
});



app.post('/affiliate/updatePayment/:id', async (req, res) => {
  const { id } = req.params; // Get the affiliate ID from URL params
  const { preferredPaymentMethod, preferredPaymentMethodValue } = req.body; // Get data from request body

  try {
    // Find the affiliate by ID and update the payment method and value
    const updatedAffiliate = await Affiliate.findByIdAndUpdate(
      id, 
      {
        preferredPaymentMethod,
        preferredPaymentMethodValue
      }, 
      { new: true } // Return the updated document
    );

    if (!updatedAffiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    res.status(200).json({ message: 'Affiliate updated successfully', data: updatedAffiliate });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error });
  }
});



app.post('/affiliate/:affiliateId/join', async (req, res) => {
  const { affiliateId } = req.params;
  const { userId, userEmail } = req.body; // Receive userId and userEmail from the request body

  try {
    const affiliate = await Affiliate.findById(affiliateId);

    if (!affiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    // Check if user has already joined
    const alreadyJoined = affiliate.usersJoined.some(user => user.userId.toString() === userId.toString());

    if (alreadyJoined) {
      return res.status(400).json({ message: 'User already joined this league' });
    }

    // Add the user to the league
    affiliate.usersJoined.push({ userId, email: userEmail });
    await affiliate.save();

    return res.status(200).json({ message: 'User successfully joined the league', affiliate });
  } catch (error) {
    return res.status(500).json({ message: 'Error joining the league', error });
  }
});



app.put('/update-profile-affiliate/:userId', async (req, res) => {
  const { userId } = req.params;
  const { firstName, lastName, playerName, phone, zipCode, shortBio } = req.body;

  try {
      // Create an object to hold the fields that should be updated
      const updateFields = {};

      if (firstName) updateFields.firstName = firstName;
      if (lastName) updateFields.lastName = lastName;
      if (playerName) updateFields.playerName = playerName;
      if (phone) updateFields.phone = phone;
      if (zipCode) updateFields.zipCode = zipCode;
      if (shortBio) updateFields.shortBio = shortBio;

      // Update the user document with the specified fields
      const updatedUser = await Affiliate.findByIdAndUpdate(userId, updateFields, { new: true });

      if (!updatedUser) {
          return res.status(404).send('User not found');
      }

      res.status(200).json({
          message: 'Profile updated successfully',
          user: updatedUser
      });
  } catch (error) {
      console.error('Error updating profile:', error);
      res.status(500).send('Server error');
  }
});


// Delete API
app.delete('/affiliatetodelete/:id', async (req, res) => {
  const { id } = req.params;
  console.log('Received DELETE request for User ID:', id);
  try {
    const user = await Affiliate.findByIdAndDelete(id);
    
    res.status(200).json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});


// Get Matches API
app.get('/affiliates', async (req, res) => {
  const match = await Affiliate.find();
  res.send(match);
});

app.post('/send-email-affiliate', async (req, res) => {
  const { email, subject, message } = req.body;

  // Check if email, subject, and message are provided
  if (!email || !subject || !message) {
      return res.status(400).json({ message: 'Email, subject, and message are required' });
  }

  try {
      // Send mail with the defined transport object
      await transporter.sendMail({
          from: '"Fantasy mmadnress Team" <vascularbundle43@gmail.com>', // sender address
          to: email, // list of receivers
          subject: subject, // Subject line
          text: message, // plain text body
      });

      res.status(200).json({ message: 'Email sent successfully' });
  } catch (error) {
      console.error('Error sending email:', error);
      res.status(500).json({ message: 'Internal server error' });
  }
});




app.post('/affiliates/:id/verify', async (req, res) => {
  try {
      const { id } = req.params;
      const affiliate = await Affiliate.findById(id);

      if (!affiliate) {
          return res.status(404).json({ message: 'Affiliate not found' });
      }

      affiliate.verified = true;
      await affiliate.save();

      res.status(200).json({ message: 'Affiliate verified successfully', affiliate });
  } catch (error) {
      console.error('Error verifying affiliate:', error);
      res.status(500).json({ message: 'Internal server error' });
  }
});





app.post('/registerAffiliate', upload.single('image'), async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      playerName,
      email,
      phone,
      password,
      zipCode,
      isNotificationsEnabled,
      isSubscribed,
      isUSCitizen,
      isAgreed,
      hearing
    } = req.body;

    // Check if email already exists
    const existingUser = await Affiliate.findOne({ email });
    if (existingUser) {
      return res.status(400).send('Email already registered');
    }

    // Handle image upload if an image is provided
    let profileUrl = '';
    if (req.file) {
      const formData = new FormData();
      formData.append('image', req.file.buffer.toString('base64'));

      const response = await fetch('https://api.imgbb.com/1/upload?key=368cbdb895c5bed277d50d216adbfa52', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();
      profileUrl = data.data.url;
    }

    // Create new user with hashed password
    const newUser = new Affiliate({
      firstName,
      lastName,
      playerName,
      email,
      phone,
      zipCode,
      hearing,
      isNotificationsEnabled,
      isSubscribed,
      isUSCitizen,
      isAgreed,
      verified: false,
      password: await bcrypt.hash(password, 10),
      profileUrl, // Save the profile image URL
    });

    // Save the new user to the database
    await newUser.save();

    res.status(201).send('User registered successfully');
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).send('Server error');
  }
});




// Login API
app.post('/loginAffiliate', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await Affiliate.findOne({ email });

    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.cookie('token', token, { httpOnly: true, maxAge: 3600000 }); // 1 hour

    res.status(200).json({
      message: 'Login successful',
      token,  // Return token in response body
      user: {
        id: user._id,
        verified: user.verified,
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});






















const scoreSchema = new mongoose.Schema({
  playerId: String,
  matchId: String,
  predictions: [{ 
    round: Number, 
    hpPrediction1: Number,  // For Boxing or MMA (HP or ST)
    bpPrediction1: Number,  // For Boxing or MMA (BP or KI)
    hpPrediction2: Number,  // For Boxing or MMA (HP or ST)
    bpPrediction2: Number,  // For Boxing or MMA (BP or KI)
    tpPrediction1: Number,  // For Boxing or MMA (TP or KN)
    tpPrediction2: Number,  // For Boxing or MMA (TP or KN)
    rwPrediction1: Number, 
    rwPrediction2: Number, 
    koPrediction1: Number, 
    koPrediction2: Number,
    elPrediction1: Number,  // For MMA only (EL)
    elPrediction2: Number   // For MMA only (EL)
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

















const adminSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  email: String,
  password: String,
  profileUrl: String, // Add profileUrl field
});

const Admin = mongoose.model('Admin', adminSchema);

app.post('/admin/register', async (req, res) => {
  const { firstName, lastName, email, password, profileUrl } = req.body;

  try {
    // Check if the email already exists
    const existingAdmin = await Admin.findOne({ email });
    if (existingAdmin) {
      return res.status(400).json({ message: 'Admin already exists' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create a new admin
    const newAdmin = new Admin({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      profileUrl,
    });

    // Save the admin to the database
    await newAdmin.save();

    res.status(201).json({ message: 'Admin registered successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find the admin by email
    const admin = await Admin.findOne({ email });
    if (!admin) {
      return res.status(400).json({ message: 'Invalid email or password.' });
    }

    // Compare the provided password with the stored hashed password
    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid email or password.' });
    }

    // Generate a JWT token
    const token = jwt.sign(
      { id: admin._id, email: admin.email },
      process.env.JWT_SECRET_ADMIN,
      { expiresIn: '1h' }
    );

    

    res.status(200).json({ token, message: 'Login successful.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
});

















const youtubeVideosSchema = new mongoose.Schema({
  videoUrl: String, 
});



const YoutubeVideos = mongoose.model('YoutubeVideos', youtubeVideosSchema);



// Delete Match API
app.delete('/youtubevideotodelete/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const user = await YoutubeVideos.findByIdAndDelete(id);
    
    res.status(200).json({ message: 'YoutubeVideos deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/youtubeVideos', async (req, res) => {
  const { videoUrl } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ message: 'Video URL is required' });
  }

  try {
    // Check if the video URL already exists in the database
    const existingVideo = await YoutubeVideos.findOne({ videoUrl });

    if (existingVideo) {
      return res.status(409).json({ message: 'This video already exists in the library' });
    }

    // If not, create a new video entry
    const newVideo = new YoutubeVideos({ videoUrl });
    await newVideo.save();

    res.status(201).json({ message: 'YouTube video added successfully', video: newVideo });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get Matches API
app.get('/youtubeVideos', async (req, res) => {
  const match = await YoutubeVideos.find();
  res.send(match);
});







// Start server
const server = app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
