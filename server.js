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
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const accessToken = process.env.ZENPAYMENTS_ACCESS_TOKEN;
const terminalId = process.env.ZENPAYMENTS_TERMINAL_ID;
const { promisify } = require('util');

const axios = require('axios');
const fetch = require('node-fetch');
const xml2js = require('xml2js');

const ALGORITHM = 'aes-256-cbc'; // AES algorithm
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Must be 32 bytes
const IV_LENGTH = 16; // For AES, this is always 16
const cloudinary = require('cloudinary').v2;

// Configure Cloudinary with environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Example of generating a random IV for encryption
const iv = crypto.randomBytes(IV_LENGTH);

app.use(express.json());

// CORS configuration
const allowedOrigins = [
  'https://fantasymmadness-version2.vercel.app', // Production
  'http://localhost:3000',
  'https://www.fantasymmadness.com',
  'https://fantasymmadness.com', // Add this line
  'http://18.212.65.201:3000'
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


const builder = new xml2js.Builder({
  headless: true,
  rootName: 'createTransactionRequest', // Set the root element name
  renderOpts: { pretty: false },
  xmldec: { version: '1.0', encoding: 'UTF-8' }
});
// File upload configuration
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const shadowSchema = new mongoose.Schema({
  matchCategory: String, // 'boxing' or 'mma'
  matchCategoryTwo: String,
  matchName: String,
  matchFighterA: String,
  matchFighterB: String,
  promotionBackground: String,
  matchDescription: String,
  matchVideoUrl: String,
  fighterAImage: String,  // URL of Fighter A's image
  fighterBImage: String,  // URL of Fighter B's image
  matchType: String,      // LIVE or SHADOW
  maxRounds: Number,
  fighterAImageDeleteUrl: String, // ImgBB delete URL for Fighter A's image
  fighterBImageDeleteUrl: String, 
  promotionBackgroundDeleteUrl: String, 
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

app.post(
  '/editShadow',
  upload.fields([
    { name: 'fighterAImage' },
    { name: 'fighterBImage' },
    { name: 'promotionBackground' },
  ]),
  async (req, res) => {
    try {
      const {
        matchId,
        matchCategoryTwo,
        maxRounds,
        matchCategory,
        matchName,
        matchFighterA,
        matchFighterB,
        matchDescription,
        fighterAImageUrl,
        fighterBImageUrl,
        promotionBackgroundUrl,
      } = req.body;

      let fighterAImage,
        fighterBImage,
        fighterAImageDeleteUrl,
        fighterBImageDeleteUrl,
        promotionBackgroundUrls,
        promotionBackgroundDeleteUrl;

      // Validate matchId
      if (!matchId) {
        return res.status(400).json({ error: 'matchId is required' });
      }

      // Fetch the existing match by matchId
      const existingMatch = await Shadow.findById(matchId);
      if (!existingMatch) {
        return res.status(404).json({ error: 'Match not found' });
      }

      // Use provided image URLs or handle uploads
      if (fighterAImageUrl) {
        fighterAImage = fighterAImageUrl;
      } else if (req.files.fighterAImage) {
        // Upload fighter A image to Cloudinary
        const resultA = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'shadow/fighterA' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(req.files.fighterAImage[0].buffer);
        });

        fighterAImage = resultA.secure_url;
        fighterAImageDeleteUrl = resultA.public_id;

        // Delete the old image
        if (existingMatch.fighterAImageDeleteUrl) {
          await cloudinary.uploader.destroy(existingMatch.fighterAImageDeleteUrl);
        }
      }

      if (fighterBImageUrl) {
        fighterBImage = fighterBImageUrl;
      } else if (req.files.fighterBImage) {
        // Upload fighter B image to Cloudinary
        const resultB = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'shadow/fighterB' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(req.files.fighterBImage[0].buffer);
        });

        fighterBImage = resultB.secure_url;
        fighterBImageDeleteUrl = resultB.public_id;

        // Delete the old image
        if (existingMatch.fighterBImageDeleteUrl) {
          await cloudinary.uploader.destroy(existingMatch.fighterBImageDeleteUrl);
        }
      }

      if (promotionBackgroundUrl) {
        promotionBackgroundUrls = promotionBackgroundUrl;
      } else if (req.files.promotionBackground) {
        // Upload promotion background image to Cloudinary
        const resultBackground = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'shadow/promotionBackground' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(req.files.promotionBackground[0].buffer);
        });

        promotionBackgroundUrls = resultBackground.secure_url;
        promotionBackgroundDeleteUrl = resultBackground.public_id;

        // Delete the old background image
        if (existingMatch.promotionBackgroundDeleteUrl) {
          await cloudinary.uploader.destroy(existingMatch.promotionBackgroundDeleteUrl);
        }
      }

      // Update the match object
      existingMatch.matchCategory = matchCategory || existingMatch.matchCategory;
      existingMatch.matchName = matchName || existingMatch.matchName;
      existingMatch.matchFighterA = matchFighterA || existingMatch.matchFighterA;
      existingMatch.matchFighterB = matchFighterB || existingMatch.matchFighterB;
      existingMatch.matchDescription = matchDescription || existingMatch.matchDescription;
      existingMatch.maxRounds = maxRounds || existingMatch.maxRounds;
      existingMatch.matchCategoryTwo = matchCategoryTwo || existingMatch.matchCategoryTwo;

      if (fighterAImage) existingMatch.fighterAImage = fighterAImage;
      if (fighterBImage) existingMatch.fighterBImage = fighterBImage;
      if (fighterAImageDeleteUrl) existingMatch.fighterAImageDeleteUrl = fighterAImageDeleteUrl;
      if (fighterBImageDeleteUrl) existingMatch.fighterBImageDeleteUrl = fighterBImageDeleteUrl;
      if (promotionBackgroundUrls) existingMatch.promotionBackground = promotionBackgroundUrls;
      if (promotionBackgroundDeleteUrl) existingMatch.promotionBackgroundDeleteUrl = promotionBackgroundDeleteUrl;

      // Save the updated match
      const updatedMatch = await existingMatch.save();

      res.status(200).json({
        message: 'Match updated successfully',
        matchId: updatedMatch._id,
      });
    } catch (error) {
      console.error('Error updating match:', error);
      res.status(500).json({ error: 'An error occurred while updating the match' });
    }
  }
);


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
    
    if (shadowFight.promotionBackgroundDeleteUrl) {
      await fetch(shadowFight.promotionBackgroundDeleteUrl, { method: 'DELETE' });
    }

    // Delete the shadow fight from the database
    await Shadow.findByIdAndDelete(id);

    res.status(200).json({ message: 'Shadow fight and associated images deleted successfully' });
  } catch (error) {
    console.error('Error deleting shadow fight:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get Matches API
app.get('/shadow', async (req, res) => {
  try {
    const matches = await Shadow.find().sort({ _id: -1 }); // Sort by _id in descending order
    res.send(matches);
  } catch (err) {
    res.status(500).send({ message: 'Error fetching matches' });
  }
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
  matchPromotionalVideoUrl: String,
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

  promotionBackgroundDeleteUrl:String,
  promotionBackground:String,

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
app.post('/api/matches/:matchId/promotional-video', async (req, res) => {
  const { matchId } = req.params;
  const { promotionalVideoUrl } = req.body;

  try {
    // Find the match by ID and update the promotional video URL
    const updatedMatch = await Match.findByIdAndUpdate(
      matchId,
      { matchPromotionalVideoUrl: promotionalVideoUrl },
      { new: true } // Return the updated document
    );

    if (!updatedMatch) {
      return res.status(404).json({ message: 'Match not found' });
    }

    res.json({
      message: 'Promotional video URL updated successfully',
      match: updatedMatch,
    });
  } catch (error) {
    console.error('Error updating promotional video URL:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST API to update match reward status by matchId
app.post('/api/update-match-reward', async (req, res) => {
  try {
    const { matchId, matchReward } = req.body;

    // Validate matchReward value
    if (!['Rewarded', 'NotRewarded'].includes(matchReward)) {
      return res.status(400).json({ success: false, message: 'Invalid matchReward value' });
    }

    // Find the match by matchId and update the matchReward status
    const match = await Match.findByIdAndUpdate(
      matchId, 
      { matchReward },
      { new: true }
    );

    if (!match) {
      return res.status(404).json({ success: false, message: 'Match not found' });
    }

    res.status(200).json({ success: true, message: 'Match reward status updated successfully', match });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error });
  }
});


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
app.post(
  '/addMatch',
  upload.fields([{ name: 'fighterAImage' }, { name: 'fighterBImage' }, { name: 'promotionBackground' }]),
  async (req, res) => {
    try {
      const {
        BoxingMatch,
        MMAMatch,
        matchCategoryTwo,
        shadowFightId,
        maxRounds,
        affiliateId,
        matchBy,
        profit,
        amountOverPotBudget,
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
        matchType,
      } = req.body;

      // Upload images to Cloudinary
      const uploadToCloudinary = (fileBuffer, folder) =>
        new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(fileBuffer);
        });

      let fighterAImage, fighterBImage, promotionBackground;
      let fighterAImageDeleteUrl, fighterBImageDeleteUrl, promotionBackgroundDeleteUrl;

      if (req.files.fighterAImage) {
        const resultA = await uploadToCloudinary(req.files.fighterAImage[0].buffer, 'fighter_images');
        fighterAImage = resultA.secure_url;
        fighterAImageDeleteUrl = resultA.public_id;
      }

      if (req.files.fighterBImage) {
        const resultB = await uploadToCloudinary(req.files.fighterBImage[0].buffer, 'fighter_images');
        fighterBImage = resultB.secure_url;
        fighterBImageDeleteUrl = resultB.public_id;
      }

      if (req.files.promotionBackground) {
        const resultBackground = await uploadToCloudinary(req.files.promotionBackground[0].buffer, 'promotion_backgrounds');
        promotionBackground = resultBackground.secure_url;
        promotionBackgroundDeleteUrl = resultBackground.public_id;
      }

      // Create match data object
      const matchData = {
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
        matchType,
        affiliateId,
        matchBy,
        profit,
        amountOverPotBudget,
        maxRounds,
        shadowFightId,
        matchCategoryTwo,
        fighterAImage,
        fighterBImage,
        fighterAImageDeleteUrl,
        fighterBImageDeleteUrl,
        promotionBackground,
        promotionBackgroundDeleteUrl,
      };

// Conditionally append BoxingMatch and MMAMatch only if they have values
if (BoxingMatch) {
  matchData.BoxingMatch = JSON.parse(BoxingMatch);
}

if (MMAMatch) {
  matchData.MMAMatch = JSON.parse(MMAMatch);
}

// Save the match details to the database
const newMatch = new Match(matchData);
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
  

  if (req.body.notify === 'true' || req.body.notify === true) {

  const users = await User.find();
  
  
  const registeredUserMailPromises = users.map(user => {
    const mailOptions = {
      from: 'Fantasymmadness2@gmail.com',
      to: user.email,
      subject: 'Fantasy mmadness',
   html: `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
    <!-- Logo Section -->
    <tr>
      <td align="center" style="padding: 15px 0;">
        <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy mmadness Logo" style="width:100px;" />
        <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy mmadness</h2>
      </td>
    </tr>
    
    <!-- Greeting Section -->
    <tr>
      <td style="padding: 10px 0;">
        <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName} ${user.lastName},</p>
        <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">We are excited to announce a new fight has been added:</p>
        <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Fight Added:</strong> ${matchName}</p>
      </td>
    </tr>
    
    <!-- New Captivating Section -->
    <tr>
      <td align="center" style="padding: 20px; background-color:#f8f8f8;">
        <h2 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">Gear Up for Battle!</h2>
        <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
          Your next adrenaline-pumping challenge awaits. Enter the arena and put your prediction skills to the test.
          Every punch, kick, and knockout is a step closer to victory!
        </p>
      </td>
    </tr>
    
    <!-- Fighter Section -->
    <tr>
      <td>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin:auto;">
          <tr>
            <!-- Fighter A -->
            <td align="center" style="padding: 10px;">
              <div style="width:60px; height:60px; border-radius:50%; border:3px solid red; background-color:#fff;">
                <img src="${fighterAImage}" alt="Fighter A" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />
              </div>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333; text-align:center;">${matchFighterA}</p>
            </td>

            <!-- VS -->
            <td align="center" style="padding: 10px;">
              <h1 style="margin:0; font-family: Arial, sans-serif; color: #333;">Vs</h1>
            </td>

            <!-- Fighter B -->
            <td align="center" style="padding: 10px;">
              <div style="width:60px; height:60px; border-radius:50%; border:3px solid blue; background-color:#fff;">
                <img src="${fighterBImage}" alt="Fighter B" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />
              </div>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333; text-align:center;">${matchFighterB}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Match Details Section -->
    <tr>
      <td style="padding: 10px;">
        <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Date:</strong> ${matchDate}</p>
       <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
  <strong>Time:</strong> ${new Date(`1970-01-01T${matchTime}:00`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })} EST</p>
 <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Max Rounds:</strong> ${maxRounds}</p>
        <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Fight Type:</strong> ${matchType}</p>
        <p><a href="https://fantasymmadness.com/upcomingfights" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">Click here</a> to get more details</p>
      </td>
    </tr>

    <!-- Footer Section -->
    <tr>
      <td align="center" style="padding: 15px 0;">
        <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy mmadness Logo" style="width:70px;" />
        <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
      </td>
    </tr>
  </table>
`

,
    };

    return transporter.sendMail(mailOptions);
  });

  // Wait for all emails to be sent
  try {
    await Promise.all(mailPromises);
    console.log('Emails sent successfully');
  } catch (error) {
    console.error('Error sending emails:', error);
  }



  // Fetch non-registered users
const nonRegisteredUsers = await Usernonregistered.find();

const nonRegisteredUserMailPromises = nonRegisteredUsers.map(user => {
  const mailOptions = {
    from: 'Fantasymmadness2@gmail.com',
    to: user.email, // Assuming you have email field here
    subject: 'Join the Excitement at Fantasy mmadness!',
    html: `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy mmadness Logo" style="width:100px;" />
            <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy mmadness</h2>
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0;">
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.fullName},</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">We noticed you haven't registered yet, and we want to invite you to join the Fantasy mmadness community!</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Sign up now to unleash your prediction skills and be part of the action!</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Don't miss out on the next thrilling fight between <strong>${matchFighterA}</strong> and <strong>${matchFighterB}</strong>!</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Date: <strong>${matchDate}</strong>, Time: <strong>${matchTime}</strong>.</p>
            <p><a href="https://fantasymmadness.com/CreateAccount" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">Register Now</a></p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy mmadness Logo" style="width:70px;" />
            <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
          </td>
        </tr>
      </table>
    `,
  };

  return transporter.sendMail(mailOptions);
});

  // Wait for all emails to be sent
  try {
    await Promise.all([...registeredUserMailPromises, ...nonRegisteredUserMailPromises]);
    console.log('Emails sent successfully to all users');
  } catch (error) {
    console.error('Error sending emails:', error);
  } 
  
  
} else {
    console.log('Notification skipped because notify is set to false');
  }

  // Respond with success and the saved match ID
  res.status(200).json({ message: 'Match Added Successfully and Notifications Sent', matchId: savedMatch._id });
} catch (error) {
  console.error('Error adding match:', error);
  res.status(500).json({ message: 'Server error', error: error.message });
}
}
);
app.post(
  '/editMatch',
  upload.fields([
    { name: 'fighterAImage' },
    { name: 'fighterBImage' },
    { name: 'promotionBackground' },
  ]),
  async (req, res) => {
    const {
      matchId,
      matchCategoryTwo,
      maxRounds,
      profit,
      matchCategory,
      matchName,
      matchFighterA,
      matchFighterB,
      matchDescription,
      matchDate,
      matchTime,
      matchTokens,
      pot,
      matchType,
      fighterAImageUrl,
      fighterBImageUrl,
      promotionBackgroundUrl,
    } = req.body;

    let fighterAImage,
      fighterBImage,
      fighterAImageDeleteUrl,
      fighterBImageDeleteUrl,
      promotionBackground,
      promotionBackgroundDeleteUrl;

    try {
      // Check if matchId is provided and valid
      if (!matchId) {
        return res.status(400).json({ error: 'matchId is required' });
      }

      // Fetch the existing match by matchId
      const existingMatch = await Match.findById(matchId);
      if (!existingMatch) {
        return res.status(404).json({ error: 'Match not found' });
      }

      // Use the image URLs directly if they are provided
      if (fighterAImageUrl) fighterAImage = fighterAImageUrl;
      if (fighterBImageUrl) fighterBImage = fighterBImageUrl;

      // Handle image uploads for Fighter A
      if (req.files.fighterAImage) {
        const resultA = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'fighterAImages' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(req.files.fighterAImage[0].buffer);
        });

        fighterAImage = resultA.secure_url;
        fighterAImageDeleteUrl = resultA.public_id;
      }

      // Handle image uploads for Fighter B
      if (req.files.fighterBImage) {
        const resultB = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'fighterBImages' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(req.files.fighterBImage[0].buffer);
        });

        fighterBImage = resultB.secure_url;
        fighterBImageDeleteUrl = resultB.public_id;
      }

      // Handle promotion background upload
      if (req.files.promotionBackground) {
        const resultBackground = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'promotionBackgrounds' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(req.files.promotionBackground[0].buffer);
        });

        promotionBackground = resultBackground.secure_url;
        promotionBackgroundDeleteUrl = resultBackground.public_id;
      } else if (promotionBackgroundUrl) {
        // Use the existing promotion background URL if provided
        promotionBackground = promotionBackgroundUrl;
      }

      // Update the match object
      existingMatch.matchCategory = matchCategory || existingMatch.matchCategory;
      existingMatch.matchName = matchName || existingMatch.matchName;
      existingMatch.matchFighterA =
        matchFighterA || existingMatch.matchFighterA;
      existingMatch.matchFighterB =
        matchFighterB || existingMatch.matchFighterB;
      existingMatch.matchDescription =
        matchDescription || existingMatch.matchDescription;
      existingMatch.matchDate = matchDate || existingMatch.matchDate;
      existingMatch.matchTime = matchTime || existingMatch.matchTime;
      existingMatch.matchTokens = matchTokens || existingMatch.matchTokens;
      existingMatch.pot = pot || existingMatch.pot;
      existingMatch.matchType = matchType || existingMatch.matchType;
      existingMatch.profit = profit || existingMatch.profit;
      existingMatch.maxRounds = maxRounds || existingMatch.maxRounds;
      existingMatch.matchCategoryTwo =
        matchCategoryTwo || existingMatch.matchCategoryTwo;

      if (fighterAImage) existingMatch.fighterAImage = fighterAImage;
      if (fighterBImage) existingMatch.fighterBImage = fighterBImage;
      if (fighterAImageDeleteUrl)
        existingMatch.fighterAImageDeleteUrl = fighterAImageDeleteUrl;
      if (fighterBImageDeleteUrl)
        existingMatch.fighterBImageDeleteUrl = fighterBImageDeleteUrl;

      if (promotionBackground)
        existingMatch.promotionBackground = promotionBackground;
      if (promotionBackgroundDeleteUrl)
        existingMatch.promotionBackgroundDeleteUrl = promotionBackgroundDeleteUrl;

      // Save the updated match to the database
      const updatedMatch = await existingMatch.save();

      // Respond with success and the updated match data
      res.status(200).json({
        message: 'Match updated successfully',
        matchId: updatedMatch._id,
      });
    } catch (error) {
      console.error('Error updating match:', error);
      res
        .status(500)
        .json({ error: 'An error occurred while updating the match' });
    }
  }
);





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



































// Function to encrypt card details
const encrypt = (text) => {
  try {

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);

    let encrypted = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final(),
    ]);

    // Return IV and encrypted data as a single string
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (error) {
    console.error('Error encrypting data:', error);
    throw new Error('Encryption failed');
  }
};





// Function to decrypt card details
function decrypt(text) {
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}




const SALT_ROUNDS = 10;

const userSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  playerName: String,
  zipCode: String,
  tokens: { type: String, default: '0' },
  email: { type: String, required: true, unique: true },
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
  profileDeleteUrl: String,
  currentPlan: { type: String, default: 'None' }, // Current subscription plan
  freePlanExpiryDate: Date, // Date when the free plan expires
  hasAvailedFreePlan: { type: Boolean, default: false }, // Indicates if the user has availed the free plan
  preferredPaymentMethod: String,
  preferredPaymentMethodValue: String,
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  hasSubmittedTestimonial: { type: Boolean, default: false },
  billing: {
    cardNumber: { type: String },  // Encrypted
    expirationDate: { type: String },  // Encrypted
    cardCode: { type: String },  // Encrypted
    address: String,
    city: String,
    state: String,
    zip: String,
    country: String
  },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);


app.post('/admin/add-user', async (req, res) => {
  const { firstName, lastName, email, password } = req.body;

  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try {
    // Check if User already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists.' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new User with default values and profileUrl
    const newUser = new User({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      verified: true,
      isNotificationsEnabled: true,
      isSubscribed: true,
      isAgreed: true,
      profileUrl: "https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png",
    });

    await newUser.save();

    // Email to the User
    await transporter.sendMail({
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: email,
      subject: 'Welcome to Fantasy Madness!',
      html: `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
              <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
            </td>
          </tr>

          <tr>
            <td style="padding: 10px 0;">
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${firstName},</p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                You have been successfully added to the Fantasy Madness by our administrators!
              </p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Below are your login credentials:
              </p>
              <ul style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                <li><strong>Email:</strong> ${email}</li>
                <li><strong>Password:</strong> ${password}</li>
              </ul>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Please log in at <a href="https://fantasymmadness.com/login" style="color: #191164; text-decoration: none;">https://fantasymmadness.com/login</a> to explore your account and get started!
              </p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                If you have any questions, feel free to reach out to us!
              </p>
            </td>
          </tr>

          <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>   
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px; width:35px; height:35px; border-radius:50%; background:#fff; background-color:#fff;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%; background-color:#fff; background:#fff;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
          </div>
        </td>
      </tr>
    
        </table>
      `,
    });

    // Email to the admin
    await transporter.sendMail({
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: 'Fantasymmadness2@gmail.com', // Replace with admin email
      subject: 'User Successfully Added',
      html: `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
            <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
          </td>
        </tr>
  
        <tr>
          <td style="padding: 10px 0;">
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              You have successfully added a new User to the Fantasy Madness with the following details:
            </p>
            <ul style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              <li><strong>First Name:</strong> ${firstName}</li>
              <li><strong>Last Name:</strong> ${lastName}</li>
              <li><strong>Email:</strong> ${email}</li>
            </ul>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              The User has been notified of their login credentials.
            </p>
          </td>
        </tr>
  
          <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>   
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px; width:35px; height:35px; border-radius:50%; background:#fff; background-color:#fff;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%; background-color:#fff; background:#fff;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
          </div>
        </td>
      </tr>
      
      </table> `,
    });

    res.status(201).json({ message: 'User added successfully and emails sent.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'An error occurred while adding the User.' });
  }
});



app.post('/forgotPassword-user', async (req, res) => {
  const { email } = req.body;

  try {
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).send('User not found');
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

    // Set reset token and expiration time (e.g., 1 hour)
    user.resetPasswordToken = resetTokenHash;
    user.resetPasswordExpires = Date.now() + 3600000;

    await user.save();

    // Send email with reset token
    const resetURL = `https://fantasymmadness.com/resetPassword-user/${resetToken}`;

    const mailOptions = {
      to: user.email,
      from: 'wajih786hassan@gmail.com',
      subject: 'Password Reset Request',
      text: `You are receiving this because you have requested a password reset for your account.\n\n
      Please click the following link to reset your password:\n\n
      ${resetURL}\n\n
      If you did not request this, please ignore this email.\n`,
    };

    await transporter.sendMail(mailOptions);
    
    res.status(200).send('Password reset email sent');
  } catch (error) {
    console.error('Error sending reset password email:', error);
    res.status(500).send('Server error');
  }
});


app.post('/resetPassword-user/:token', async (req, res) => {
  try {
    // Hash the token from the URL to match the stored hash
    const resetTokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');

    // Find the User by the token and ensure the token hasn't expired
    const user = await User.findOne({
      resetPasswordToken: resetTokenHash,
      resetPasswordExpires: { $gt: Date.now() }, // Ensure token is not expired
    });

    if (!user) {
      return res.status(400).send('Invalid or expired token');
    }

    // Update the password and remove the reset token and expiry
    user.password = await bcrypt.hash(req.body.password, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();

    res.status(200).send('Password has been reset');
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).send('Server error');
  }
});




app.post('/api/authorize-net/first-payment', async (req, res) => {
  const { email, amount, cardNumber, expirationDate, cardCode, address, city, state, zip, country } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Construct the XML payload for Authorize.Net
    const payload = {
      $: { 'xmlns': 'AnetApi/xml/v1/schema/AnetApiSchema.xsd' }, // Add namespace
      merchantAuthentication: {
        name: process.env.AUTHORIZE_NET_API_LOGIN_ID,
        transactionKey: process.env.AUTHORIZE_NET_TRANSACTION_KEY,
      },
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: amount,
        payment: {
          creditCard: {
            cardNumber: cardNumber,
            expirationDate: expirationDate,
            cardCode: cardCode,
          },
        },
        order: {
          invoiceNumber: `INV-${new Date().getTime()}`,
          description: 'First-time payment',
        },
        customer: {
          email: email,
        },
        billTo: {
          firstName: user.firstName,
          lastName: user.lastName,
          address: address,
          city: city,
          state: state,
          zip: zip,
          country: country,
        },
      },
    };

    const xmlPayload = builder.buildObject(payload);

    // Send the transaction request to Authorize.Net
    const response = await axios.post('https://api.authorize.net/xml/v1/request.api', xmlPayload, {
      headers: {
        'Content-Type': 'application/xml',
      },
    });

    // Log the raw response
    console.log('Authorize.Net raw response:', response.data);
    xml2js.parseString(response.data, async (err, result) => {
      if (err) {
          console.error('Error parsing XML response:', err);
          return res.status(500).json({ message: 'Error parsing payment response' });
      }
  
      const createTransactionResponse = result.createTransactionResponse;
      const transactionResponse = createTransactionResponse?.transactionResponse?.[0];
      const responseCode = transactionResponse?.responseCode?.[0];
  
      if (responseCode === '1') {
          // Transaction was successful
  
          // Encrypt card details
          const encryptedCardNumber = encrypt(cardNumber);
          const encryptedExpirationDate = encrypt(expirationDate);
          const encryptedCardCode = encrypt(cardCode);
  
          // Store encrypted details in user billing
          user.billing = {
              cardNumber: encryptedCardNumber,
              expirationDate: encryptedExpirationDate,
              cardCode: encryptedCardCode,
              address,
              city,
              state,
              zip,
              country,
          };
  
          // Add tokens to the user's account
          user.tokens = (parseInt(user.tokens, 10) + parseInt(amount, 10)).toString();
          user.currentPlan = 'Standard';
          await user.save();
  
          return res.status(200).json({
              message: 'Payment processed and user updated successfully',
              transactionId: transactionResponse.transId?.[0],
              authCode: transactionResponse.authCode?.[0],
          });
      } else {
        // Transaction failed, handle the failure case
        const errorMessage = transactionResponse?.messages?.[0]?.message?.[0]?.description || 'Unknown error';
        console.log('Authorize.Net transaction failed:', errorMessage);
        return res.status(400).json({
          message: 'Payment failed',
          details: errorMessage,
        });
      }
    });
  } catch (error) {
    console.error('Error processing first payment:', error);
    return res.status(500).json({ message: 'Error processing payment', error: error.message });
  }
});
app.post('/api/authorize-net/transaction', async (req, res) => {
  const { email, amount } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Decrypt card details
    const cardNumber = decrypt(user.billing.cardNumber);
    const expirationDate = decrypt(user.billing.expirationDate);
    const cardCode = decrypt(user.billing.cardCode);

    // Check if decryption was successful
    if (!cardNumber || !expirationDate || !cardCode) {
      return res.status(400).json({ message: 'Invalid card details' });
    }

    // Construct the payload for Authorize.Net
    const payload = {
      $: { 'xmlns': 'AnetApi/xml/v1/schema/AnetApiSchema.xsd' }, // Add namespace
      merchantAuthentication: {
        name: process.env.AUTHORIZE_NET_API_LOGIN_ID,
        transactionKey: process.env.AUTHORIZE_NET_TRANSACTION_KEY,
      },
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: amount,
        payment: {
          creditCard: {
            cardNumber: cardNumber,
            expirationDate: expirationDate,
            cardCode: cardCode,
          },
        },
        order: {
          invoiceNumber: `INV-${new Date().getTime()}`,
          description: 'Purchase description here',
        },
        customer: {
          email: user.email,
        },
        billTo: {
          firstName: user.firstName,
          lastName: user.lastName,
          address: user.billing.address,
          city: user.billing.city,
          state: user.billing.state,
          zip: user.billing.zip,
          country: user.billing.country,
        },
      },
    };

    const xmlPayload = builder.buildObject(payload);

    // Send the transaction request to Authorize.Net
    const response = await axios.post('https://api.authorize.net/xml/v1/request.api', xmlPayload, {
      headers: {
        'Content-Type': 'application/xml',
      },
    });

    // Parse XML response
    xml2js.parseString(response.data, async (err, result) => {
      if (err) {
        console.error('Error parsing XML response:', err);
        return res.status(500).json({ message: 'Error parsing transaction response' });
      }

      const createTransactionResponse = result.createTransactionResponse;
      const transactionResponse = createTransactionResponse?.transactionResponse?.[0];
      const responseCode = transactionResponse?.responseCode?.[0];

      if (responseCode === '1') {
        // Transaction was successful
        user.tokens = (parseInt(user.tokens, 10) + parseInt(amount, 10)).toString();
        await user.save();

        return res.status(200).json({
          message: 'Transaction successful and tokens added',
          transactionId: transactionResponse.transId?.[0],
          authCode: transactionResponse.authCode?.[0],
        });
      } else {
        // Transaction failed
        const errorMessage = transactionResponse?.messages?.[0]?.message?.[0]?.description || 'Unknown error';
        console.log('Authorize.Net transaction failed:', errorMessage);
        return res.status(400).json({
          message: 'Transaction failed',
          details: errorMessage,
        });
      }
    });
  } catch (error) {
    console.error('Error processing transaction:', error.response?.data || error.message);
    return res.status(500).json({ message: 'Error processing transaction', error: error.message });
  }
});

// Google Login API
app.post('/google-login', async (req, res) => {
  const { token } = req.body;

  try {
    // Verify Google token
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { name, email, picture } = ticket.getPayload();

    // Check if the email exists in Redusers
    const redListedUser = await Redusers.findOne({ email });
    if (redListedUser) {
      // Send email notification if user is on red list
      await transporter.sendMail({
        from: 'Fantasymmadness2@gmail.com',
        to: email,
        subject: 'Login Blocked',
        html: `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
          <!-- Logo Section -->
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
              <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
            </td>
          </tr>
          
          <!-- Greeting Section -->
          <tr>
            <td style="padding: 10px 0;">
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear User,</p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Due to violations of our terms and conditions, your account is flagged, and login is blocked on Fantasy Madness. 
              </p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                If you believe this is a mistake, please contact our support team.
              </p>
            </td>
          </tr>

          <!-- Footer Section -->
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
              <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
            </td>
          </tr>
        </table>
      `,
      });

      return res.status(403).json({ message: 'Login blocked due to red list status.' });
    }

    // Check if the user exists
    let user = await User.findOne({ email });

    if (!user) {
      // If user does not exist, create a new user
      user = new User({
        firstName: name.split(' ')[0],
        lastName: name.split(' ')[1] || '',
        email,
        profileUrl: picture,
        verified: true, // Mark as verified for Google login
        isNotificationsEnabled: true, // Notifications enabled
        isSubscribed: true, // Subscribed to updates
        isAgreed: true, // Agreed to terms and conditions
      });

      await user.save();

      // Send welcome email to the new user
      await transporter.sendMail({
        from: 'Fantasymmadness2@gmail.com',
        to: email,
        subject: 'Welcome to Fantasy Madness!',
        html: `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
              <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 10px 0;">
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName},</p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Welcome to Fantasy Madness! We're thrilled to have you on board. Dive into the excitement and start your journey today!
              </p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
              <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
            </td>
          </tr>
        </table>
      `,
      });

      // Notify admins about the new signup
      await transporter.sendMail({
        from: 'Fantasymmadness2@gmail.com',
        to: ['wajih786hassan@gmail.com', 'Fantasymmadness2@gmail.com'], // Replace with actual admin emails
        subject: 'New User Signup Notification',
        html: `
        <p>A new user has signed up on Fantasy Madness:</p>
        <ul>
          <li>Name: ${user.firstName} ${user.lastName}</li>
          <li>Email: ${user.email}</li>
        </ul>
      `,
      });
    }

    // Generate JWT token
    const jwtToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // Return JWT token and user info
    res.status(200).json({
      message: 'Google login successful',
      token: jwtToken,
      user: {
        id: user._id,
        name: user.firstName + ' ' + user.lastName,
        email: user.email,
        profileUrl: user.profileUrl,
      },
    });
  } catch (error) {
    console.error('Google login error', error);

    // Send error email to admins
    await transporter.sendMail({
      from: 'Fantasymmadness2@gmail.com',
      to: ['wajih786hassan@gmail.com', 'Fantasymmadness2@gmail.com'], // Replace with actual admin emails
      subject: 'Google Login Error Notification',
      html: `
      <p>An error occurred during a Google login attempt. Please investigate the issue.</p>
      <p><strong>Error Details:</strong></p>
      <pre>${error.message}</pre>
    `,
    });

    res.status(500).json({ message: 'Internal server error' });
  }
});




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

// Update Profile API
app.put('/update-profile/:userId', upload.single('image'), async (req, res) => {
  const { userId } = req.params;
  const {
    firstName,
    lastName,
    playerName,
    phone,
    zipCode,
    shortBio,
    isNotificationsEnabled,
    isSubscribed,
    isUSCitizen,
  } = req.body;

  try {
    // Create an object to hold the fields that should be updated
    const updateFields = {};

    // Add other fields to be updated
    if (firstName) updateFields.firstName = firstName;
    if (lastName) updateFields.lastName = lastName;
    if (playerName) updateFields.playerName = playerName;
    if (phone) updateFields.phone = phone;
    if (zipCode) updateFields.zipCode = zipCode;
    if (shortBio) updateFields.shortBio = shortBio;
    if (isNotificationsEnabled !== undefined) updateFields.isNotificationsEnabled = isNotificationsEnabled;
    if (isSubscribed !== undefined) updateFields.isSubscribed = isSubscribed;
    if (isUSCitizen !== undefined) updateFields.isUSCitizen = isUSCitizen;

    // Check if a new image is provided
    if (req.file) {
      // Find the user to retrieve the previous profile details
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Delete previous image from Cloudinary if delete URL exists
      if (user.profileDeleteUrl) {
        await cloudinary.uploader.destroy(user.profileDeleteUrl);
      }

      // Upload new image to Cloudinary
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder: 'profiles' },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        ).end(req.file.buffer);
      });

      updateFields.profileUrl = result.secure_url; // URL for accessing the image
      updateFields.profileDeleteUrl = result.public_id; // Cloudinary public ID for deletion
    }

    // Update the user document with the specified fields
    const updatedUser = await User.findByIdAndUpdate(userId, updateFields, { new: true });

    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({
      message: 'Profile updated successfully',
      user: updatedUser,
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ message: 'Server error' });
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

// POST API to reward tokens to the user and update matchReward status
app.post('/api/reward-tokens-only-forcibly/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { tokens } = req.body;

    // Find the user by ID
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add tokens to the user's account
    user.tokens = parseInt(user.tokens, 10) + parseInt(tokens, 10);

    // Save the updated user
    await user.save();

    res.status(200).json({ success: true, message: 'Tokens rewarded successfully', user});
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
    user: 'Fantasymmadness2@gmail.com',
    pass: 'nxoozxaywvjzivsh',
  },
});

app.post('/contact-us-fantasymmadness', (req, res) => {
  const { fullName, email, subject, message } = req.body;

  // Validate input (basic validation)
  if (!fullName || !email || !message) {
    return res.status(400).json({ error: 'Full name, email, and message are required.' });
  }
  // Email template for Admin
  const adminHtml = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
      <!-- Header Section -->
      <tr>
        <td align="center" style="padding: 15px 0;">
          <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
          <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
        </td>
      </tr>
      
      <!-- Message Details Section -->
      <tr>
        <td style="padding: 20px; font-family: Arial, sans-serif; color: #333;">
          <p style="font-size: 16px;"><strong>Full Name:</strong> ${fullName}</p>
          <p style="font-size: 16px;"><strong>Email:</strong> ${email}</p>
          <p style="font-size: 16px;"><strong>Subject:</strong> ${subject || 'No Subject'}</p>
          <p style="font-size: 16px;"><strong>Message:</strong></p>
          <p style="font-size: 16px; color: #555;">${message}</p>
        </td>
      </tr>

      <!-- Footer Section with Social Icons -->
      <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%;" />
            </a>
          </div>
        </td>
      </tr>
    </table>
  `;

  // Email template for User
  const userHtml = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
      <!-- Header Section -->
      <tr>
       <td align="center" style="padding: 15px 0;">
          <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
          <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
        </td>
     </tr>
      
      <!-- Message Confirmation Section -->
      <tr>
        <td style="padding: 20px; font-family: Arial, sans-serif; color: #333;">
          <p style="font-size: 16px;">Hello ${fullName},</p>
          <p style="font-size: 16px; color: #555;">
            Thank you for reaching out! We have received your message and will get back to you as soon as possible. Here's a summary of your submission:
          </p>
          <p style="font-size: 16px;"><strong>Subject:</strong> ${subject || 'No Subject'}</p>
          <p style="font-size: 16px;"><strong>Message:</strong></p>
          <p style="font-size: 16px; color: #555;">${message}</p>
        </td>
      </tr>

      <!-- Footer Section with Social Icons -->
      <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px; width:35px; height:35px; border-radius:50%; background:#fff; background-color:#fff;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%; background-color:#fff; background:#fff;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
          </div>
        </td>
      </tr>
    </table>
  `;


  // Admin email options
  const adminMailOptions = {
    from: email,
    to: 'Fantasymmadness2@gmail.com',
    subject: `Contact Form Submission: ${subject}`,
    html: adminHtml,
  };

  // User email options
  const userMailOptions = {
    from: 'Fantasymmadness2@gmail.com',
    to: email,
    subject: 'Thank You for Contacting Fantasy Madness!',
    html: userHtml,
  };

  // Send both emails
  Promise.all([
    transporter.sendMail(adminMailOptions),
    transporter.sendMail(userMailOptions)
  ])
    .then(([adminInfo, userInfo]) => {
      console.log('Admin email sent:', adminInfo.response);
      console.log('User email sent:', userInfo.response);
      res.status(200).json({ message: 'Emails sent successfully.' });
    })
    .catch(error => {
      console.error('Error sending emails:', error);
      res.status(500).json({ error: 'Failed to send emails.' });
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
        from: '"Fantasy MMAdness" <Fantasymmadness2@gmail.com>', // sender address
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

  try {
    // Check if email exists in Redusers
    const redListedUser = await Redusers.findOne({ email });
    if (redListedUser) {
      // Send email notification if user is on red list
      const mailOptions = {
        from: 'Fantasymmadness2@gmail.com',
        to: email,
        subject: 'Registration Blocked',
        html: `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
          <!-- Logo Section -->
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
              <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
            </td>
          </tr>
          
          <!-- Greeting Section -->
          <tr>
            <td style="padding: 10px 0;">
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${firstName},</p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Due to violations of our terms and conditions, your account is flagged, and registration is blocked on Fantasy Madness. 
              </p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                If you believe this is a mistake, please contact our support team.
              </p>
            </td>
          </tr>

          <!-- Footer Section -->
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
              <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
            </td>
          </tr>
        </table>
      `,
      };

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.error('Error sending email notification:', error);
        } else {
          console.log('Notification email sent successfully:', info.response);
        }
      });

      return res.status(403).send('Registration blocked due to red list status.');
    }

    // Check if email already exists in the User collection
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
          from: 'Fantasymmadness2@gmail.com',
          to: email,
          subject: 'Verification Failed',
          html: `<p>Dear ${user.firstName},</p>
                 <p>You have failed to verify your email within the required time. Your registration has been canceled.</p>
                 <p>If this was a mistake, please register again.</p>`,
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
      from: 'Fantasymmadness2@gmail.com',
      to: email,
      subject: 'Email Verification',
      html: `<p>Thank you for registering with us. Please click the link below to verify your email address:</p>
             <a href="${verificationLink}">Verify Email</a>`,
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        return res.status(500).send('Error sending verification email');
      } else {
        res.status(200).send('Registration successful! Please check your email to verify your account.');
      }
    });
  } catch (error) {
    res.status(500).send('Error during registration');
  }
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


app.delete('/usertodelete/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Find the user by ID
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Delete profile image from imgbb if a delete URL exists
    if (user.profileDeleteUrl) {
      await fetch(user.profileDeleteUrl, { method: 'DELETE' })
        .then(response => {
          if (!response.ok) {
            console.warn('Failed to delete profile image from imgbb');
          }
        })
        .catch(error => {
          console.error('Error deleting image from imgbb:', error);
        });
    }

    // Delete the user from the database
    await User.findByIdAndDelete(id);

    res.status(200).json({ message: 'User and profile image deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
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
    const { verified, firstName, lastName, playerName, phone, zipCode, profileUrl , _id } = user;

    // Return the user information along with the verification status
    res.json({ 
      verified, 
      firstName, 
      lastName, 
      playerName, 
      phone, 
      zipCode,
      profileUrl ,
      _id
    });
  } catch (error) {
    res.status(500).send('Internal server error');
  }
});


app.post('/upload-avatar', upload.single('image'), async (req, res) => {
  try {
    const { email } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: 'No image file provided' });
    }

    // Find the user to retrieve the previous avatar details
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Delete the previous avatar from Cloudinary if it exists
    if (user.profileDeleteUrl) {
      await cloudinary.uploader.destroy(user.profileDeleteUrl);
    }

    // Upload the new avatar to Cloudinary
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'avatars' },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      ).end(req.file.buffer);
    });

    // Update the user with the new avatar URL and public ID
    user.profileUrl = result.secure_url; // New avatar URL
    user.profileDeleteUrl = result.public_id; // Cloudinary public ID for deletion
    await user.save();

    res.status(200).json({ message: 'Avatar uploaded and saved successfully', profileUrl: user.profileUrl });
  } catch (error) {
    console.error('Error uploading avatar:', error);
    res.status(500).json({ message: 'Server error' });
  }
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



// Cron Job Route
app.get('/api/cron-job', async (req, res) => {
  console.log('Cron job started.');

  try {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0); // Normalize 'now' to midnight UTC

    // Find all LIVE matches
    const liveMatches = await Match.find({ matchType: 'LIVE' });

    // Filter matches to only include those with a past date (ignoring time)
    const matchesToConvert = liveMatches.filter((match) => {
      const matchDate = new Date(match.matchDate);
      matchDate.setUTCHours(0, 0, 0, 0); // Normalize match date to midnight UTC
      return matchDate < now; // Match date is in the past
    });

    if (matchesToConvert.length === 0) {
      console.log('No matches to convert to shadow.');
      return res.status(200).json({ message: 'No matches to convert to shadow.' });
    }

    for (const match of matchesToConvert) {
      // Create and save shadow match
      const shadowMatch = new Shadow({
        matchCategory: match.matchCategory,
        matchCategoryTwo: match.matchCategoryTwo,
        matchName: match.matchName,
        matchFighterA: match.matchFighterA,
        matchFighterB: match.matchFighterB,
        promotionBackground: match.promotionBackground,
        matchDescription: match.matchDescription,
        fighterAImage: match.fighterAImage,
        fighterBImage: match.fighterBImage,
        matchType: 'SHADOW',
        maxRounds: match.maxRounds,
        fighterAImageDeleteUrl: match.fighterAImageDeleteUrl,
        fighterBImageDeleteUrl: match.fighterBImageDeleteUrl,
        promotionBackgroundDeleteUrl: match.promotionBackgroundDeleteUrl,
      });

      await shadowMatch.save();


      // Optionally, update the original match to reflect the conversion
      match.matchType = 'SHADOW';
      await match.save();

      console.log(`Converted match ${match._id} to shadow.`);
      const users = await Affiliate.find();
      const mailPromises = users.map((user) => {
        const mailOptions = {
          from: 'Fantasymmadness2@gmail.com',
          to: user.email,
          subject: 'Fantasy MMAdness - New Fight Announcement',
          html: `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
              <!-- Logo Section -->
              <tr>
                <td align="center" style="padding: 15px 0;">
                  <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy mmadness Logo" style="width:100px;" />
                  <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy mmadness</h2>
                </td>
              </tr>
              
              <!-- Greeting Section -->
              <tr>
                <td style="padding: 10px 0;">
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName} ${user.lastName},</p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">We're thrilled to announce that a new Shadow Fight has been added to your dashboard, ready for promotion.</p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Fight Name:</strong> ${match.matchName}</p>
                </td>
              </tr>
              
              <!-- Affiliate Call-to-Action Section -->
              <tr>
                <td align="center" style="padding: 20px; background-color:#f8f8f8;">
                  <h2 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">Take the Lead!</h2>
                  <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                    The new Shadow Fight is now available for promotion. Share the excitement with your audience, build anticipation, and engage them in this thrilling event. 
                  </p>
                  <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                    Boost your league’s activity by encouraging fans to participate, and don’t miss the opportunity to expand your reach and earn rewards.
                  </p>
                </td>
              </tr>
    
              <!-- Match Details Section -->
              <tr>
                <td style="padding: 10px;">
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Max Rounds:</strong> ${match.maxRounds}</p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Match Type:</strong> SHADOW</p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    Now is the time to activate your followers and get them involved. Start promoting the fight today, and keep the excitement growing in your community!
                  </p>
                </td>
              </tr>
    
              <!-- Footer Section -->
              <tr>
                <td align="center" style="padding: 15px 0;">
                  <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy mmadness Logo" style="width:70px;" />
                  <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
                </td>
              </tr>
            </table>
          `,
        };
        return transporter.sendMail(mailOptions);
      });

      try {
        await Promise.all(mailPromises);
        console.log(`Emails sent successfully for match ${match._id}`);
      } catch (error) {
        console.error(`Error sending emails for match ${match._id}:`, error);
      }
    }

    res.status(200).json({ message: 'Cron job completed successfully.' });
  } catch (error) {
    console.error('Error in cron job:', error);
    res.status(500).json({ error: 'Cron job failed.' });
  }
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










const adminTokensSchema = new mongoose.Schema({
  tokens: { type: String, default: '0' },
  affiliateRewarded: { type: String, default: '0' },
  matchId: String, 
  matchName: String, 
  totalTokens: { type: String, default: '0' }, // New field to track total tokens
}, { timestamps: true });

const Admintokens = mongoose.model('Admintokens', adminTokensSchema);

// POST API to reward tokens to the admin and update matchReward status
app.post('/api/reward-tokens-to-admin', async (req, res) => {
  try {
    const { tokens, matchId, matchName, affiliateRewarded } = req.body;

    // Fetch or create an admin token document
    let adminToken = await Admintokens.findOne({ matchId });

    if (!adminToken) {
      adminToken = new Admintokens({ matchId, matchName });
    }

    // Add tokens to the admin's account and update totalTokens
    adminToken.tokens = (parseInt(adminToken.tokens, 10) + parseInt(tokens, 10)).toString();
    adminToken.affiliateRewarded = (parseInt(adminToken.affiliateRewarded, 10) + parseInt(affiliateRewarded, 10)).toString();
    adminToken.totalTokens = (parseInt(adminToken.totalTokens, 10) + parseInt(tokens, 10)).toString();

    await adminToken.save();

    res.status(200).json({ success: true, message: 'Tokens added to Admin wallet successfully', adminToken });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error });
  }
});





// GET API to fetch all admin token details
app.get('/api/admin-tokens', async (req, res) => {
  try {
    // Fetch all admin tokens from the database
    const adminTokens = await Admintokens.find();

    if (adminTokens.length === 0) {
      return res.status(404).json({ success: false, message: 'No admin tokens found' });
    }

    // Return all admin token details
    res.status(200).json({ 
      success: true, 
      message: 'Admin token data fetched successfully', 
      adminTokens 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error });
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
  totalViews: { type: Number, default: 0 },
verified: { type: Boolean, default: false },
  profileUrl: String,
  profileDeleteUrl: String,
  tokens: { type: String, default: '0' },
  preferredPaymentMethod: String, 
  preferredPaymentMethodValue: String, 
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  usersJoined: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // User who joined
    email: String,  // Email of the user who joined
    joinedAt: { type: Date, default: Date.now } // Timestamp
  }],
  payouts: [{
    amount: Number, // Example of amount paid
    createdAt: { type: Date, default: Date.now }, // Timestamp for payout creation
    status: { type: String, default: 'pending' } // Status of the payout, default is 'pending'
  }]
}, { timestamps: true });

const Affiliate = mongoose.model('Affiliate', affiliateSchema);

app.post('/admin/add-affiliate', async (req, res) => {
  const { firstName, lastName, email, password } = req.body;

  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try {
    // Check if affiliate already exists
    const existingAffiliate = await Affiliate.findOne({ email });
    if (existingAffiliate) {
      return res.status(400).json({ message: 'Affiliate with this email already exists.' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new affiliate with default values and profileUrl
    const newAffiliate = new Affiliate({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      verified: true,
      isNotificationsEnabled: true,
      isSubscribed: true,
      isAgreed: true,
      profileUrl: "https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png",
    });

    await newAffiliate.save();

    // Email to the affiliate
    await transporter.sendMail({
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: email,
      subject: 'Welcome to Fantasy Madness Affiliate Program!',
      html: `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
              <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
            </td>
          </tr>

          <tr>
            <td style="padding: 10px 0;">
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${firstName},</p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                You have been successfully added to the Fantasy Madness Affiliate Program by our administrators!
              </p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Below are your login credentials:
              </p>
              <ul style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                <li><strong>Email:</strong> ${email}</li>
                <li><strong>Password:</strong> ${password}</li>
              </ul>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Please log in at <a href="https://fantasymmadness.com/login" style="color: #191164; text-decoration: none;">https://fantasymmadness.com/login</a> to explore your account and get started!
              </p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                If you have any questions, feel free to reach out to us!
              </p>
            </td>
          </tr>

          <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>   
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px; width:35px; height:35px; border-radius:50%; background:#fff; background-color:#fff;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%; background-color:#fff; background:#fff;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
          </div>
        </td>
      </tr>
    
        </table>
      `,
    });

    // Email to the admin
    await transporter.sendMail({
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: 'Fantasymmadness2@gmail.com', // Replace with admin email
      subject: 'Affiliate Successfully Added',
      html: `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
            <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
          </td>
        </tr>
  
        <tr>
          <td style="padding: 10px 0;">
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              You have successfully added a new affiliate to the Fantasy Madness program with the following details:
            </p>
            <ul style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              <li><strong>First Name:</strong> ${firstName}</li>
              <li><strong>Last Name:</strong> ${lastName}</li>
              <li><strong>Email:</strong> ${email}</li>
            </ul>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              No approval is needed as the account was added directly by you. The affiliate has been notified of their login credentials.
            </p>
          </td>
        </tr>
  
          <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>   
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px; width:35px; height:35px; border-radius:50%; background:#fff; background-color:#fff;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%; background-color:#fff; background:#fff;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
          </div>
        </td>
      </tr>
      
      </table> `,
    });

    res.status(201).json({ message: 'Affiliate added successfully and emails sent.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'An error occurred while adding the affiliate.' });
  }
});




app.post('/affiliate-google-login', async (req, res) => {
  const { token } = req.body;

  try {
    // Verify Google token
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { name, email, picture } = ticket.getPayload();

    // Check if the affiliate exists
    let affiliate = await Affiliate.findOne({ email });

    if (!affiliate) {
      // If affiliate does not exist, create a new one
      affiliate = new Affiliate({
        firstName: name.split(' ')[0],
        lastName: name.split(' ')[1] || '', // Handle single-word names
        email,
        profileUrl: picture,
        verified: false, // Mark as unverified, admin will verify
        isNotificationsEnabled: true, // Notifications enabled
        isSubscribed: true, // Subscribed to updates
        isAgreed: true, // Agreed to terms and conditions
      });

      await affiliate.save();



      // Send welcome email to the affiliate
      await transporter.sendMail({
        from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
        to: email, // Affiliate's email
        subject: 'Welcome to Fantasy Madness Affiliate Program!',
        html: `
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
            <tr>
              <td align="center" style="padding: 15px 0;">
                <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
                <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
              </td>
            </tr>

            <tr>
              <td style="padding: 10px 0;">
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${affiliate.firstName},</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                  Welcome to Fantasy Madness! Your registration as an affiliate has been received and is pending approval by our administrators.
                </p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                  You will be notified once your account is approved. Meanwhile, feel free to explore our platform and learn more about our affiliate program.
                </p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding: 15px 0;">
                <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
                <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
              </td>
            </tr>
          </table>
        `,
      });



      // Send email notification to admin for approval
      const approvalLink = `https://fantasymmadness-game-server-three.vercel.app/approveAffiliate/${affiliate._id}`;

      await transporter.sendMail({
        from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
        to: 'Fantasymmadness2@gmail.com', // Admin email
        subject: 'New Affiliate Registration - Approval Needed',
        html: `
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
            <tr>
              <td align="center" style="padding: 15px 0;">
                <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
                <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
              </td>
            </tr>

            <tr>
              <td style="padding: 10px 0;">
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear Admin,</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                  A new affiliate <strong>${affiliate.firstName} ${affiliate.lastName}</strong> has registered via Google Login on Fantasy Madness. Please review and approve their profile.
                </p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding: 20px; background-color:#f8f8f8;">
                <img src="${affiliate.profileUrl}" alt="Affiliate Profile" style="width:60px; height:60px; border-radius:50%; border:3px solid #191164;" />
                <h3 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">Affiliate Details</h3>
                <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                  Name: ${affiliate.firstName} ${affiliate.lastName}<br>
                  Email: ${affiliate.email}
                </p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding: 20px;">
                <a href="${approvalLink}" style="display:inline-block; padding:10px 20px; color:#fff; background-color:#191164; border-radius:5px; text-decoration:none; font-family: Arial, sans-serif;">Approve Now</a>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding: 15px 0;">
                <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
                <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
              </td>
            </tr>
          </table>
        `,
      });
    }

    // Generate JWT token
    const jwtToken = jwt.sign({ id: affiliate._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // Return JWT token and affiliate info
    res.status(200).json({
      message: 'Affiliate Google login successful',
      token: jwtToken,
      affiliate: {
        id: affiliate._id,
        name: `${affiliate.firstName} ${affiliate.lastName}`.trim(),
        email: affiliate.email,
        profileUrl: affiliate.profileUrl,
        verified: affiliate.verified,
      },
    });
  } catch (error) {
    console.error('Affiliate Google login error', error);

    // Send email notification about login failure
    await transporter.sendMail({
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: ['Fantasymmadness2@gmail.com', 'wajih786hassan@gmail.com'], // Recipients
      subject: 'Affiliate Google Login Failed',
      html: `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
              <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
            </td>
          </tr>

          <tr>
            <td style="padding: 10px 0;">
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear Admins,</p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                An error occurred during an affiliate Google login attempt:
              </p>
              <p style="font-size: 16px; font-family: 'Courier New', monospace; color: #d20a0a; background-color: #f8d7da; border-radius: 5px; padding: 10px; border: 1px solid #f5c6cb;">
                ${error.message}
              </p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding: 15px 0;">
              <p style="font-family: Arial, sans-serif; color: #191164;">Please investigate the issue at your earliest convenience.</p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
              <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
            </td>
          </tr>
        </table>
      `,
    });

    res.status(500).json({ message: 'Internal server error' });
  }
});



// Route to increment totalViews
app.post('/affiliate/:affiliateId/incrementViews', async (req, res) => {
  try {
    const { affiliateId } = req.params;
    const updatedAffiliate = await Affiliate.findByIdAndUpdate(
      affiliateId,
      { $inc: { totalViews: 1 } },
      { new: true }
    );

    if (!updatedAffiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    res.status(200).json(updatedAffiliate);
  } catch (error) {
    console.error('Error incrementing views:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


app.post('/forgotPassword', async (req, res) => {
  const { email } = req.body;

  try {
    // Find the affiliate by email
    const affiliate = await Affiliate.findOne({ email });
    if (!affiliate) {
      return res.status(404).send('Affiliate not found');
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

    // Set reset token and expiration time (e.g., 1 hour)
    affiliate.resetPasswordToken = resetTokenHash;
    affiliate.resetPasswordExpires = Date.now() + 3600000;

    await affiliate.save();

    // Send email with reset token
    const resetURL = `https://fantasymmadness.com/resetPassword/${resetToken}`;

    const mailOptions = {
      to: affiliate.email,
      from: 'wajih786hassan@gmail.com',
      subject: 'Password Reset Request',
      text: `You are receiving this because you have requested a password reset for your account.\n\n
      Please click the following link to reset your password:\n\n
      ${resetURL}\n\n
      If you did not request this, please ignore this email.\n`,
    };

    await transporter.sendMail(mailOptions);
    
    res.status(200).send('Password reset email sent');
  } catch (error) {
    console.error('Error sending reset password email:', error);
    res.status(500).send('Server error');
  }
});


app.post('/resetPassword/:token', async (req, res) => {
  try {
    // Hash the token from the URL to match the stored hash
    const resetTokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');

    // Find the affiliate by the token and ensure the token hasn't expired
    const affiliate = await Affiliate.findOne({
      resetPasswordToken: resetTokenHash,
      resetPasswordExpires: { $gt: Date.now() }, // Ensure token is not expired
    });

    if (!affiliate) {
      return res.status(400).send('Invalid or expired token');
    }

    // Update the password and remove the reset token and expiry
    affiliate.password = await bcrypt.hash(req.body.password, 10);
    affiliate.resetPasswordToken = undefined;
    affiliate.resetPasswordExpires = undefined;

    await affiliate.save();

    res.status(200).send('Password has been reset');
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).send('Server error');
  }
});


app.delete('/affiliates/:id/payouts-to-delete', async (req, res) => {
  const affiliateId = req.params.id;

  try {
      // Find the affiliate by id
      const affiliate = await Affiliate.findById(affiliateId);

      if (!affiliate) {
          return res.status(404).json({ message: 'Affiliate not found' });
      }

      // Remove all payouts
      affiliate.payouts = [];

      // Save the updated affiliate document
      await affiliate.save();

      // Send success response
      res.status(200).json({ message: 'All payouts have been deleted for this affiliate', affiliate });
  } catch (error) {
      console.error('Error deleting payouts:', error);
      res.status(500).json({ message: 'Server error. Unable to delete payouts.' });
  }
});






app.post('/affiliate/:id/payout', async (req, res) => {
  try {
    const { amount } = req.body; // The payout amount should be passed in the request body
    const affiliateId = req.params.id;

    // Find the affiliate by ID
    const affiliate = await Affiliate.findById(affiliateId);

    if (!affiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    // Add the new payout to the payouts array
    const payout = { amount, createdAt: new Date() };
    affiliate.payouts.push(payout);

    // Save the updated affiliate
    await affiliate.save();

    // Send email notification
    const mailOptions = {
      from: 'Fantasymmadness2@gmail.com',
      to: 'Fantasymmadness2@gmail.com', // Admin email
      subject: 'New Payout Request',
      text: `
        Hello Admin,
        
        There is a new payout request from the following affiliate:
        
        Affiliate Details:
        Name: ${affiliate.firstName} ${affiliate.lastName}
        Email: ${affiliate.email}
        Phone: ${affiliate.phone}

        Payout Request Details:
        Amount: $${amount}
        Requested On: ${payout.createdAt}

        Thank you!
      `,
    };

    // Send email
    await transporter.sendMail(mailOptions);

    // Respond to the client
    res.status(200).json({ message: 'Payout request created and email sent successfully', payout });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});


// Endpoint to confirm payment
app.post('/confirm-payment-affiliate', async (req, res) => {
    const { affiliateId, amount, payoutId } = req.body;

    try {
        // Find the affiliate by ID
        const affiliate = await Affiliate.findById(affiliateId);

        if (!affiliate) {
            return res.status(404).json({ message: 'Affiliate not found' });
        }

        // Convert tokens to a number for comparison and deduction
        const currentTokens = Number(affiliate.tokens); // Convert string to number

        // Check if the affiliate has enough tokens
        if (currentTokens < amount) {
            return res.status(400).json({ message: 'Insufficient tokens' });
        }

        // Deduct the amount from tokens
        affiliate.tokens = (currentTokens - amount).toString(); // Convert back to string

        // Update the payout status to completed
        const payout = affiliate.payouts.id(payoutId);
        if (payout) {
            payout.status = 'completed';
        } else {
            return res.status(404).json({ message: 'Payout not found' });
        }

        // Save the changes
        await affiliate.save();

        // Return a success response
        res.status(200).json({ message: 'Payment processed successfully', affiliate });
    } catch (error) {
        console.error('Error processing payment:', error);
        res.status(500).json({ message: 'Server error', error });
    }
});


app.post('/affiliate/:affiliateId/remove-user', async (req, res) => {
  const { affiliateId } = req.params;
  const { userId } = req.body; // UserId comes from the request body

  try {
    const affiliate = await Affiliate.findById(affiliateId);

    if (!affiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    // Check if user is part of the league
    const userExists = affiliate.usersJoined.some(user => user.userId.toString() === userId.toString());

    if (!userExists) {
      return res.status(400).json({ message: 'User not found in this league' });
    }

    // Remove the user from usersJoined array using $pull
    await Affiliate.findByIdAndUpdate(
      affiliateId,
      { $pull: { usersJoined: { userId: userId } } },  // Pull removes the user from the array
      { new: true }  // Return the updated document
    );

    return res.status(200).json({ message: 'User successfully removed from the league' });
  } catch (error) {
    return res.status(500).json({ message: 'Error removing user from the league', error });
  }
});



// POST API to reward tokens to the user and update matchReward status
app.post('/api/reward-tokens-to-affiliate/:affiliateId', async (req, res) => {
  try {
    const { affiliateId } = req.params;
    const { tokens } = req.body;

    // Find the user by ID
    const user = await Affiliate.findById(affiliateId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add tokens to the user's account
    user.tokens = parseInt(user.tokens, 10) + parseInt(tokens, 10);

    // Save the updated user
    await user.save();

    res.status(200).json({ success: true, message: 'Tokens rewarded to affiliate successfully', user });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error });
  }
});





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







const sendUserEmail = async (user, affiliate) => {
  const mailOptions = {
    from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
    to: user.email,
    subject: `Thank You for Joining ${affiliate.playerName}'s League!`,
    html: `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
        <!-- Logo Section -->
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
            <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
          </td>
        </tr>
        
        <!-- Greeting Section -->
        <tr>
          <td style="padding: 10px 0;">
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName},</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              Thank you for joining <strong>${affiliate.playerName}</strong>'s league!
            </p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              We are thrilled to have you on board. Stay tuned for more exciting updates and matches ahead!
            </p>
          </td>
        </tr>
        
        <!-- Affiliate Profile Section -->
        <tr>
          <td align="center" style="padding: 20px; background-color:#f8f8f8;">
            <img src="${affiliate.profileUrl}" alt="Affiliate Profile" style="width:60px; height:60px; border-radius:50%; border:3px solid #191164;" />
            <h3 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">${affiliate.playerName}'s League</h3>
            <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
              Get ready for the ultimate competition! We’re excited to see you in action.
            </p>
          </td>
        </tr>

        <!-- Footer Section -->
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
            <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
          </td>
        </tr>
      </table>
    `,
  };

  await transporter.sendMail(mailOptions);
};


const sendAffiliateEmail = async (affiliate, user) => {
  const mailOptions = {
    from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
    to: affiliate.email,
    subject: `${user.firstName} ${user.lastName} has joined your league!`,
    html: `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
        <!-- Logo Section -->
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
            <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
          </td>
        </tr>
        
        <!-- Greeting Section -->
        <tr>
          <td style="padding: 10px 0;">
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${affiliate.firstName},</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              We are excited to inform you that <strong>${user.firstName} ${user.lastName}</strong> has joined your league!
            </p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              You are now one step closer to building a fantastic team. Keep an eye on the upcoming matches and engage with your new members.
            </p>
          </td>
        </tr>

        <!-- Affiliate Profile Section -->
        <tr>
          <td align="center" style="padding: 20px; background-color:#f8f8f8;">
            <img src="${affiliate.profileUrl}" alt="Affiliate Profile" style="width:60px; height:60px; border-radius:50%; border:3px solid #191164;" />
            <h3 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">${affiliate.playerName}'s League</h3>
            <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
              Keep building your team and prepare for thrilling challenges ahead!
            </p>
          </td>
        </tr>

        <!-- Footer Section -->
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
            <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
          </td>
        </tr>
      </table>
    `,
  };

  await transporter.sendMail(mailOptions);
};

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

    // Fetch the user's details from the User collection using userId
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add the user to the league
    affiliate.usersJoined.push({ userId, email: userEmail });
    await affiliate.save();

    // Send emails to both the user and the affiliate
    await sendUserEmail(user, affiliate);
    await sendAffiliateEmail(affiliate, user);

    return res.status(200).json({ message: 'User successfully joined the league', affiliate });
  } catch (error) {
    return res.status(500).json({ message: 'Error joining the league', error });
  }
});
app.put('/update-profile-affiliate/:userId', upload.single('image'), async (req, res) => {
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

    // Check if a new image is provided
    if (req.file) {
      // Find the affiliate to retrieve the previous delete URL
      const affiliate = await Affiliate.findById(userId);
      if (!affiliate) {
        return res.status(404).send('Affiliate not found');
      }

      // Delete the previous image from Cloudinary if delete URL exists
      if (affiliate.profileDeleteUrl) {
        await cloudinary.uploader.destroy(affiliate.profileDeleteUrl);
      }

      // Upload new avatar image to Cloudinary
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder: 'affiliates' },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        ).end(req.file.buffer);
      });

      updateFields.profileUrl = result.secure_url;
      updateFields.profileDeleteUrl = result.public_id;
    }

    // Update the affiliate document with the specified fields
    const updatedAffiliate = await Affiliate.findByIdAndUpdate(userId, updateFields, { new: true });

    if (!updatedAffiliate) {
      return res.status(404).send('Affiliate not found');
    }

    res.status(200).json({
      message: 'Profile updated successfully',
      user: updatedAffiliate,
    });
  } catch (error) {
    console.error('Error updating affiliate profile:', error);
    res.status(500).send('Server error');
  }
});

// Delete Affiliate API
app.delete('/affiliatetodelete/:id', async (req, res) => {
  const { id } = req.params;
  console.log('Received DELETE request for Affiliate ID:', id);

  try {
    // Find the affiliate by ID
    const affiliate = await Affiliate.findById(id);
    if (!affiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    // Delete profile image from imgbb if a delete URL exists
    if (affiliate.profileDeleteUrl) {
      await fetch(affiliate.profileDeleteUrl, { method: 'DELETE' })
        .then(response => {
          if (!response.ok) {
            console.warn('Failed to delete affiliate profile image from imgbb');
          }
        })
        .catch(error => {
          console.error('Error deleting image from imgbb:', error);
        });
    }

    // Delete the affiliate from the database
    await Affiliate.findByIdAndDelete(id);

    res.status(200).json({ message: 'Affiliate and profile image deleted successfully' });
  } catch (error) {
    console.error('Error deleting affiliate:', error);
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
          from: '"Fantasy mmadnress Team" <Fantasymmadness2@gmail.com>', // sender address
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
    let profileDeleteUrl = '';
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder: 'affiliates' },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        ).end(req.file.buffer);
      });

      profileUrl = result.secure_url;
      profileDeleteUrl = result.public_id;
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
      profileDeleteUrl, // Save the delete URL for future image deletion
    });

    // Save the new user to the database
    await newUser.save();

    const approvalLink = `https://fantasymmadness-game-server-three.vercel.app/approveAffiliate/${newUser._id}`;

    // Send email notification to the admin
    await transporter.sendMail({
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: 'Fantasymmadness2@gmail.com', // Admin email
      subject: 'New Affiliate Registration - Approval Needed',
      html: `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
              <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 10px 0;">
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear Admin,</p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                A new affiliate <strong>${newUser.firstName} ${newUser.lastName}</strong> has registered on Fantasy Madness. Please review and approve their profile.
              </p>
            </td>
          </tr>
          
          <tr>
            <td align="center" style="padding: 20px; background-color:#f8f8f8;">
              <img src="${newUser.profileUrl}" alt="Affiliate Profile" style="width:60px; height:60px; border-radius:50%; border:3px solid #191164;" />
              <h3 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">Affiliate Details</h3>
              <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                Name: ${newUser.firstName} ${newUser.lastName}<br>
                Email: ${newUser.email}<br>
                Phone: ${newUser.phone}<br>
                ZIP Code: ${newUser.zipCode}
              </p>
            </td>
          </tr>

         <tr>
           <td align="center" style="padding: 20px;">
             <a href="${approvalLink}" style="display:inline-block; padding:10px 20px; color:#fff; background-color:#191164; border-radius:5px; text-decoration:none; font-family: Arial, sans-serif;">Approve Now</a>
           </td>
          </tr>


          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
              <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
            </td>
          </tr>
        </table>
      `,
    });

    res.status(201).send('User registered successfully');
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).send('Server error');
  }
});

app.get('/approveAffiliate/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const affiliate = await Affiliate.findById(id);

    if (!affiliate) {
      return res.status(404).send(`
        <html>
          <body style="display: flex; align-items: center; justify-content: center; height: 100vh; background-color: #333; color: white; font-family: Arial, sans-serif;">
            <h1 style="color: #ff0000; font-size: 48px;">Affiliate not found</h1>
          </body>
        </html>
      `);
    }

    // Check if the affiliate is already verified
    if (affiliate.verified) {
      return res.send(`
        <html>
          <head>
            <style>
              body {
                background-color: #000;
                color: #fff;
                font-family: Arial, sans-serif;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
              }
              .container {
                text-align: center;
                border: 2px solid #ff0000;
                padding: 20px;
                width: 80%;
                max-width: 500px;
                background-color: #222;
                border-radius: 10px;
                box-shadow: 0px 4px 15px rgba(255, 0, 0, 0.6);
              }
              h1 {
                font-size: 36px;
                margin-bottom: 15px;
                color: #ff0000;
                text-shadow: 2px 2px #000;
              }
              p {
                font-size: 18px;
                margin-bottom: 20px;
                color: #ccc;
              }
              .profile-img {
                width: 100px;
                height: 100px;
                border-radius: 50%;
                border: 3px solid #ff0000;
                margin-top: 15px;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>Affiliate Already Approved</h1>
              <p>This affiliate has already been approved previously.</p>
              <img src="${affiliate.profileUrl}" alt="Affiliate Profile Image" class="profile-img" />
            </div>
             <script>
              setTimeout(() => window.close(), 3000); // Close tab after 2 seconds
            </script>
          </body>
        </html>
      `);
    }

    // Mark affiliate as verified if not already verified
    affiliate.verified = true;
    await affiliate.save();

    // Send success response
    res.send(`
      <html>
        <head>
          <style>
            body {
              background-color: #000;
              color: #fff;
              font-family: Arial, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
            }
            .container {
              text-align: center;
              border: 2px solid #ff0000;
              padding: 20px;
              width: 80%;
              max-width: 500px;
              background-color: #222;
              border-radius: 10px;
              box-shadow: 0px 4px 15px rgba(255, 0, 0, 0.6);
            }
            h1 {
              font-size: 36px;
              margin-bottom: 15px;
              color: #ff0000;
              text-shadow: 2px 2px #000;
            }
            p {
              font-size: 18px;
              margin-bottom: 20px;
              color: #ccc;
            }
            .profile-img {
              width: 100px;
              height: 100px;
              border-radius: 50%;
              border: 3px solid #ff0000;
              margin-top: 15px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Affiliate Approved!</h1>
            <p>Congratulations! The affiliate has been successfully approved.</p>
            <img src="${affiliate.profileUrl}" alt="Affiliate Profile Image" class="profile-img" />
            <script>
              setTimeout(() => window.close(), 3000); // Close tab after 2 seconds
            </script>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error approving affiliate:', error);
    res.status(500).send(`
      <html>
        <body style="display: flex; align-items: center; justify-content: center; height: 100vh; background-color: #333; color: white; font-family: Arial, sans-serif;">
          <h1 style="color: #ff0000; font-size: 48px;">Internal Server Error</h1>
        </body>
      </html>
    `);
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



app.post('/addShadow', upload.fields([
  { name: 'fighterAImage' },
  { name: 'fighterBImage' },
  { name: 'promotionBackground' },
]), async (req, res) => {
  try {
    let fighterAImageUrl, fighterBImageUrl, promotionBackgroundUrl;
    let fighterAImageDeleteUrl, fighterBImageDeleteUrl, promotionBackgroundDeleteUrl;

    // Helper function to upload to Cloudinary
    const uploadToCloudinary = (fileBuffer, folder) => {
      return new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        ).end(fileBuffer);
      });
    };

    // Upload Fighter A Image
    if (req.files.fighterAImage) {
      const result = await uploadToCloudinary(req.files.fighterAImage[0].buffer, 'fighters');
      fighterAImageUrl = result.secure_url;
      fighterAImageDeleteUrl = result.public_id;
    }

    // Upload Fighter B Image
    if (req.files.fighterBImage) {
      const result = await uploadToCloudinary(req.files.fighterBImage[0].buffer, 'fighters');
      fighterBImageUrl = result.secure_url;
      fighterBImageDeleteUrl = result.public_id;
    }

    // Upload Promotion Background Image
    if (req.files.promotionBackground) {
      const result = await uploadToCloudinary(req.files.promotionBackground[0].buffer, 'promotions');
      promotionBackgroundUrl = result.secure_url;
      promotionBackgroundDeleteUrl = result.public_id;
    }

    const {
      matchCategoryTwo,
      maxRounds,
      matchCategory,
      matchName,
      matchFighterA,
      matchFighterB,
      matchDescription,
      matchVideoUrl,
      matchType,
    } = req.body;

    // Save match details to the database
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
      fighterAImageDeleteUrl,
      fighterBImageDeleteUrl,
      promotionBackground: promotionBackgroundUrl,
      promotionBackgroundDeleteUrl,
      matchType,
      maxRounds,
    });

    await newMatch.save();

    if (req.body.notify === 'true' || req.body.notify === true) {
      const users = await Affiliate.find();

      const mailPromises = users.map((user) => {
        const mailOptions = {
          from: 'Fantasymmadness2@gmail.com',
          to: user.email,
          subject: 'Fantasy MMAdness - New Fight Announcement',
          html: `
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
            <!-- Logo Section -->
            <tr>
              <td align="center" style="padding: 15px 0;">
                <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy mmadness Logo" style="width:100px;" />
                <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy mmadness</h2>
              </td>
            </tr>
            
            <!-- Greeting Section -->
            <tr>
              <td style="padding: 10px 0;">
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName} ${user.lastName},</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">We're thrilled to announce that a new Shadow Fight has been added to your dashboard, ready for promotion.</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Fight Name:</strong> ${matchName}</p>
              </td>
            </tr>
            
            <!-- Affiliate Call-to-Action Section -->
            <tr>
              <td align="center" style="padding: 20px; background-color:#f8f8f8;">
                <h2 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">Take the Lead!</h2>
                <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                  The new Shadow Fight is now available for promotion. Share the excitement with your audience, build anticipation, and engage them in this thrilling event. 
                </p>
                <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                  Boost your league’s activity by encouraging fans to participate, and don’t miss the opportunity to expand your reach and earn rewards.
                </p>
              </td>
            </tr>
        
            <!-- Match Details Section -->
            <tr>
              <td style="padding: 10px;">
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Max Rounds:</strong> ${maxRounds}</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Match Type:</strong> ${matchType}</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                  Now is the time to activate your followers and get them involved. Start promoting the fight today, and keep the excitement growing in your community!
                </p>
              </td>
            </tr>
        
            <!-- Footer Section -->
            <tr>
              <td align="center" style="padding: 15px 0;">
                <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy mmadness Logo" style="width:70px;" />
                <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
              </td>
            </tr>
          </table>
        `,
        };

        return transporter.sendMail(mailOptions);
      });

      try {
        await Promise.all(mailPromises);
        console.log('Emails sent successfully');
      } catch (error) {
        console.error('Error sending emails:', error);
      }
    } else {
      console.log('Notification skipped because notify is set to false');
    }

    res.status(200).json({
      message: 'Match Added Successfully and Notifications Sent',
      matchId: newMatch._id,
    });
  } catch (error) {
    console.error('Error adding shadow match:', error);
    res.status(500).send('Server error');
  }
});



app.get('/dashboard-counts', async (req, res) => {
  try {
    // Fetch counts using Mongoose's countDocuments method
    const affiliatesCount = await Affiliate.countDocuments({});
    const matchesCount = await Match.countDocuments({});
    const usersCount = await User.countDocuments({});
    const shadowTemplatesCount = await Shadow.countDocuments({});
    
    // Fetch total clicks from SiteStats
    const stats = await SiteStats.findOne({});
    const totalClicks = stats ? stats.totalClicks : 0;

    // Send response with all counts, including total clicks
    res.json({
      affiliatesCount,
      matchesCount,
      usersCount,
      shadowTemplatesCount,
      totalClicks // Include total clicks in the response
    });
  } catch (error) {
    console.error('Error fetching dashboard counts:', error);
    res.status(500).json({ error: 'Failed to fetch counts' });
  }
});





const userRemovedMatchesSchema = new mongoose.Schema({
  userId: { type: String, required: true },  // userId as a string
  removedMatchesIds: { 
      type: [String],  // array of strings to store removed match IDs
      default: [] 
  },
}, { timestamps: true });


const UserRemovedMatches = mongoose.model('UserRemovedMatches', userRemovedMatchesSchema);


app.delete('/remove-matches-of-user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
      const result = await UserRemovedMatches.deleteMany({ userId });
      
      if (result.deletedCount === 0) {
          return res.status(404).json({ message: 'No records found for this userId.' });
      }
      
      res.status(200).json({ message: 'All records removed successfully.' });
  } catch (error) {
      console.error('Error deleting records:', error);
      res.status(500).json({ message: 'Internal server error.' });
  }
});

// Add removed match for a user
app.post('/remove-match-from-my-dashboard', async (req, res) => {
  const { userId, matchId } = req.body;

  try {
      // Find the user's removed matches document
      let userMatches = await UserRemovedMatches.findOne({ userId });

      if (!userMatches) {
          // If the document doesn't exist, create it
          userMatches = new UserRemovedMatches({
              userId,
              removedMatchesIds: [matchId]
          });
      } else {
          // If it exists, check if the matchId already exists
          if (!userMatches.removedMatchesIds.includes(matchId)) {
              userMatches.removedMatchesIds.push(matchId);
          } else {
              return res.status(409).json({ message: 'Match already removed for this user' });
          }
      }

      // Save the updated document
      await userMatches.save();

      res.status(201).json({ message: 'Match removed successfully', data: userMatches });
  } catch (error) {
      res.status(500).json({ message: 'Server error', error });
  }
});

// Remove a removed match for a user
app.delete('/remove-match-from-my-dashboard', async (req, res) => {
  const { userId, matchId } = req.body;

  try {
      // Find the user's removed matches document
      let userMatches = await UserRemovedMatches.findOne({ userId });

      if (!userMatches) {
          return res.status(404).json({ message: 'No removed matches found for this user' });
      }

      // Check if the matchId exists in the removedMatchesIds array
      const matchIndex = userMatches.removedMatchesIds.indexOf(matchId);

      if (matchIndex === -1) {
          return res.status(404).json({ message: 'Match not found in removed list' });
      }

      // Remove the matchId from the array
      userMatches.removedMatchesIds.splice(matchIndex, 1);

      // Save the updated document
      await userMatches.save();

      res.status(200).json({ message: 'Match removed from dashboard successfully', data: userMatches });
  } catch (error) {
      res.status(500).json({ message: 'Server error', error });
  }
});


app.get('/user/:userId/removed-matches', async (req, res) => {
  const { userId } = req.params;

  try {
      // Find the user's removed matches document
      const userMatches = await UserRemovedMatches.findOne({ userId });

      if (!userMatches) {
          return res.status(404).json({ message: 'No matches found for this user' });
      }

      res.status(200).json(userMatches);
  } catch (error) {
      res.status(500).json({ message: 'Server error', error });
  }
});


app.get('/users/removed-matches', async (req, res) => {
  try {
      // Find all documents in the UserRemovedMatches collection
      const allUserMatches = await UserRemovedMatches.find();

      if (!allUserMatches || allUserMatches.length === 0) {
          return res.status(404).json({ message: 'No removed matches found for any user' });
      }

      res.status(200).json(allUserMatches);
  } catch (error) {
      res.status(500).json({ message: 'Server error', error });
  }
});

















const customUserSchema = new mongoose.Schema({
  fullName: String,
  email: { type: String, required: true, unique: true },
  
}, { timestamps: true });

const Usernonregistered = mongoose.model('Usernonregistered', customUserSchema);

// POST API to create a new non-registered user
app.post('/api/users/nonregistered', async (req, res) => {
  try {
    const { fullName, email } = req.body;

    // Check if the email already exists in the User collection
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      // If the email already exists, return an error
      return res.status(400).json({ message: 'Email is already registered' });
    }

    // If the email does not exist, create a new non-registered user
    const newUser = new Usernonregistered({ fullName, email });
    await newUser.save();
    
    res.status(201).json({ message: 'User created successfully', newUser });
  } catch (error) {
    res.status(400).json({ message: 'Error creating user', error });
  }
});


// GET API to fetch all non-registered users
app.get('/api/users/nonregistered', async (req, res) => {
  try {
      const users = await Usernonregistered.find();
      res.status(200).json(users);
  } catch (error) {
      res.status(500).json({ message: 'Error fetching users', error });
  }
});


// DELETE API to remove a non-registered user by ID
app.delete('/api/users/nonregistered/:id', async (req, res) => {
  try {
      const { id } = req.params;
      const deletedUser = await Usernonregistered.findByIdAndDelete(id);
      if (deletedUser) {
          res.status(200).json({ message: 'User deleted successfully' });
      } else {
          res.status(404).json({ message: 'User not found' });
      }
  } catch (error) {
      res.status(500).json({ message: 'Error deleting user', error });
  }
});





const ForumSchema = new mongoose.Schema({
  threads: [
    {
      title: { type: String, required: true }, // Thread title
      body: { type: String, required: true }, // Thread body content
      profileUrl: String,
      author: {
        userId: { type: String, required: true }, // Author's user ID stored as a string
        username: { type: String, required: true } // Author's username
      },
      views: { type: Number, default: 0 }, // Thread view count
      replies: [
        {
          body: { type: String, required: true }, // Reply content
          author: {
            userId: { type: String, required: true }, // Reply author's user ID as a string
            username: { type: String, required: true } // Reply author's username
          },
          createdDate: { type: Date, default: Date.now }, // Reply creation date
          likes: [{ type: String }] // User IDs of those who liked the reply, stored as strings
        }
      ],
      createdDate: { type: Date, default: Date.now }, // Thread creation date
      lastUpdated: { type: Date, default: Date.now }, // Last update timestamp for the thread
      locked: { type: Boolean, default: false }, // If the thread is locked
      pinned: { type: Boolean, default: false } // If the thread is pinned
    }
  ],
  notifications: [
    {
      type: { type: String, enum: ['reply', 'like', 'follow', 'mention'], required: true }, // Notification type
      recipient: { type: String, required: true }, // Recipient's user ID as a string
      sender: { type: String, required: true }, // Sender's user ID as a string
      thread: { type: String }, // Associated thread ID as a string
      post: { type: String }, // Associated post ID as a string
      read: { type: Boolean, default: false }, // Whether the notification has been read
      createdDate: { type: Date, default: Date.now } // Date of notification creation
    }
  ]
});

const Forum = mongoose.model('Forum', ForumSchema);
app.post('/threads', async (req, res) => {
  try {
    const newThread = {
      title: req.body.title,
      body: req.body.body,
      profileUrl: req.body.profileUrl,
      author: {
        userId: req.body.author.userId,
        username: req.body.author.username
      },
      createdDate: new Date(),
      lastUpdated: new Date()
    };

    // Find the forum instance, or create a new one if it doesn't exist
    let forum = await Forum.findOne();
    if (!forum) {
      forum = new Forum({ threads: [] }); // Create a new forum if none exists
    }

    forum.threads.push(newThread);
    await forum.save();

    res.status(201).json(newThread);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



// Reply to a thread
app.post('/threads/:threadId/replies', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    const thread = forum.threads.id(req.params.threadId);

    const newReply = {
      body: req.body.body,
      author: {
        userId: req.body.author.userId,
        username: req.body.author.username
      },
      createdDate: new Date()
    };

    thread.replies.push(newReply);
    thread.lastUpdated = new Date(); // Update the thread's last update time
    await forum.save();

    res.status(201).json(newReply);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Like a reply
app.post('/threads/:threadId/replies/:replyId/like', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    const thread = forum.threads.id(req.params.threadId);
    const reply = thread.replies.id(req.params.replyId);

    reply.likes.push(req.body.userId); // Push userId into likes array
    await forum.save();

    res.status(200).json({ message: 'Reply liked!' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Create a notification
app.post('/notifications', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    const newNotification = {
      type: req.body.type,
      recipient: req.body.recipient,
      sender: req.body.sender,
      thread: req.body.thread || null,
      post: req.body.post || null,
      read: req.body.read || false,
      createdDate: new Date()
    };

    forum.notifications.push(newNotification);
    await forum.save();

    res.status(201).json(newNotification);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Mark a notification as read
app.post('/notifications/:notificationId/read', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    const notification = forum.notifications.id(req.params.notificationId);

    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    notification.read = true;
    await forum.save();

    res.status(200).json({ message: 'Notification marked as read' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Get all threads
app.get('/threads', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance

    if (!forum) {
      return res.status(200).json([]); // No forum found, return an empty array
    }

    res.status(200).json(forum.threads);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



// Get a single thread by ID
app.get('/threads/:threadId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    res.status(200).json(thread);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Get all replies in a thread
app.get('/threads/:threadId/replies', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    res.status(200).json(thread.replies);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all notifications for a user
app.get('/notifications/:userId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const notifications = forum.notifications.filter(
      notification => notification.recipient === req.params.userId
    );

    res.status(200).json(notifications);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Get a single notification by ID
app.get('/notifications/:notificationId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const notification = forum.notifications.id(req.params.notificationId);

    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    res.status(200).json(notification);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete a thread
app.delete('/threads/:threadId', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    forum.threads.pull(req.params.threadId); // Remove thread using pull
    await forum.save(); // Save the updated forum

    res.status(200).json({ message: 'Thread deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
// Delete a reply from a thread
app.delete('/threads/:threadId/replies/:replyId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    const reply = thread.replies.id(req.params.replyId);
    if (!reply) return res.status(404).json({ message: 'Reply not found' });

    thread.replies.pull(req.params.replyId); // Remove reply using pull
    await forum.save();

    res.status(200).json({ message: 'Reply deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



// Delete a notification
app.delete('/notifications/:notificationId', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    const notification = forum.notifications.id(req.params.notificationId);

    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    notification.remove(); // Remove notification
    await forum.save();

    res.status(200).json({ message: 'Notification deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete all replies from a thread
app.delete('/threads/:threadId/replies', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    thread.replies = []; // Clear all replies
    await forum.save();

    res.status(200).json({ message: 'All replies deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete all threads in the forum
app.delete('/threads', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    forum.threads = []; // Clear all threads
    await forum.save();

    res.status(200).json({ message: 'All threads deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Update a thread (only by the author)
app.put('/threads/:threadId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    // Check if the user is the author of the thread
    if (thread.author.userId !== req.body.userId) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // Update thread fields
    thread.title = req.body.title || thread.title;
    thread.body = req.body.body || thread.body;
    thread.lastUpdated = Date.now();

    await forum.save();
    res.status(200).json({ message: 'Thread updated successfully', thread });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update a reply (only by the author)
app.put('/threads/:threadId/replies/:replyId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    const reply = thread.replies.id(req.params.replyId);
    if (!reply) return res.status(404).json({ message: 'Reply not found' });

    // Check if the user is the author of the reply
    if (reply.author.userId !== req.body.userId) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // Update reply fields
    reply.body = req.body.body || reply.body;
    reply.lastUpdated = Date.now();

    await forum.save();
    res.status(200).json({ message: 'Reply updated successfully', reply });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update a notification (only by the recipient)
app.put('/notifications/:notificationId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const notification = forum.notifications.id(req.params.notificationId);

    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    // Check if the user is the recipient of the notification
    if (notification.recipient !== req.body.userId) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // Update notification fields
    notification.read = req.body.read || notification.read;

    await forum.save();
    res.status(200).json({ message: 'Notification updated successfully', notification });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Increment thread views
app.put('/threads/:threadId/views', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    // Increment views count
    thread.views += 1;

    await forum.save();
    res.status(200).json({ message: 'Thread view count updated', views: thread.views });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



















const redListSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  profileUrl: String,
}, { timestamps: true });

const Redusers = mongoose.model('Redusers', redListSchema);

app.post('/redusers', async (req, res) => {
  try {
    const { email, profileUrl } = req.body;

    // Find and delete user from User collection
    const user = await User.findOneAndDelete({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found in the system' });
    }

    // Add user to the red list
    const newRedUser = new Redusers({ email, profileUrl });
    await newRedUser.save();


    const mailOptions = {
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: user.email,
      subject: 'Account Flagged Due to Violation',
      html: `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
        <!-- Logo Section -->
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
            <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
          </td>
        </tr>
        
        <!-- Greeting Section -->
        <tr>
          <td style="padding: 10px 0;">
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName},</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              Due to violations of our terms and conditions, your account has been flagged and removed from Fantasy Madness. 
            </p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              Please contact our support team if you believe this was a mistake.
            </p>
          </td>
        </tr>

        <!-- Footer Section -->
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
            <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
          </td>
        </tr>
      </table>
    `,
    };

    await transporter.sendMail(mailOptions);

    res.status(201).json({ message: 'User added to the red list and notification sent', data: newRedUser });
  } catch (error) {
    res.status(500).json({ message: 'Error adding user to the red list or sending email', error: error.message });
  }
});

// GET API - Get all users from the red list
app.get('/redusers', async (req, res) => {
  try {
    const redUsers = await Redusers.find();
    res.status(200).json({ message: 'Red list users retrieved', data: redUsers });
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving red list users', error: error.message });
  }
});

// DELETE API - Remove a user from the red list by email
app.delete('/redusers/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const deletedUser = await Redusers.findOneAndDelete({ email });
    if (!deletedUser) {
      return res.status(404).json({ message: 'User not found in the red list' });
    }
    res.status(200).json({ message: 'User removed from the red list', data: deletedUser });
  } catch (error) {
    res.status(500).json({ message: 'Error removing user from the red list', error: error.message });
  }
});






const siteStatsSchema = new mongoose.Schema({
  totalClicks: { type: Number, default: 0 },
  trackedDevices: { type: [String], default: [] }, // Array to store unique device IDs
  clicksByDate: { 
    type: Map, 
    of: Number, 
    default: new Map() // Map to store dates and their respective click counts
  },
});

const SiteStats = mongoose.model('SiteStats', siteStatsSchema);
app.post('/track-click', async (req, res) => {
  const { deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).send({ message: 'Device ID is required' });
  }

  try {
    const today = new Date().toISOString().split('T')[0]; // Get current date in YYYY-MM-DD format

    // Find the stats document (assuming there's only one)
    let stats = await SiteStats.findOne({});

    if (!stats) {
      // Create a new stats document if it doesn't exist
      stats = await SiteStats.create({
        totalClicks: 0,
        trackedDevices: [],
        clicksByDate: new Map(),
      });
    }

    // Check if the device ID is already tracked
    if (stats.trackedDevices.includes(deviceId)) {
      return res.status(200).send({ 
        message: 'Device already tracked', 
        totalClicks: stats.totalClicks, 
        clicksByDate: Object.fromEntries(stats.clicksByDate) // Convert Map to plain object for response
      });
    }

    // Add the device ID and increment the total clicks
    stats.totalClicks += 1;
    stats.trackedDevices.push(deviceId);

    // Increment the click count for today
    stats.clicksByDate.set(today, (stats.clicksByDate.get(today) || 0) + 1);

    await stats.save();

    res.status(200).send({ 
      message: 'Click tracked', 
      totalClicks: stats.totalClicks, 
      clicksByDate: Object.fromEntries(stats.clicksByDate) // Convert Map to plain object for response
    });
  } catch (error) {
    console.error('Error tracking click:', error);
    res.status(500).send({ message: 'Error tracking click' });
  }
});



app.get('/get-total-clicks', async (req, res) => {
  try {
    // Find the single document storing site stats
    const stats = await SiteStats.findOne({});
    
    res.status(200).send({ stats });
  } catch (error) {
    console.error('Error fetching total clicks:', error);
    res.status(500).send({ message: 'Error fetching total clicks' });
  }
});

app.post('/reset-stats', async (req, res) => {
  try {
    // Delete the stats document(s)
    await SiteStats.deleteMany({});
    
    // Respond with a success message
    res.status(200).send({ message: 'All site stats have been reset successfully.' });
  } catch (error) {
    console.error('Error resetting stats:', error);
    res.status(500).send({ message: 'Error resetting stats.' });
  }
});















const faqSchema = new mongoose.Schema({
  title: String,
  description:String,
});

const Faqs = mongoose.model('Faqs', faqSchema);


app.delete('/all/delete/faqs', async (req, res) => {
  try {
    // Delete all documents from the Faqs collection
    const result = await Faqs.deleteMany({});
    res.status(200).json({
      message: 'All FAQs deleted successfully.',
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Error deleting FAQs:', error);
    res.status(500).json({ error: 'Failed to delete FAQs from the database.' });
  }
});

app.post('/faqs', async (req, res) => {
  try {
    const faq = new Faqs(req.body);
    await faq.save();
    res.status(201).json({ success: true, data: faq });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.get('/faqs', async (req, res) => {
  try {
    const faqs = await Faqs.find();
    res.status(200).json({ success: true, data: faqs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/faqs/:id', async (req, res) => {
  try {
    const faq = await Faqs.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!faq) return res.status(404).json({ success: false, message: 'FAQ not found' });
    res.status(200).json({ success: true, data: faq });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.delete('/faqs/:id', async (req, res) => {
  try {
    const faq = await Faqs.findByIdAndDelete(req.params.id);
    if (!faq) return res.status(404).json({ success: false, message: 'FAQ not found' });
    res.status(200).json({ success: true, message: 'FAQ deleted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.post('/faqs/bulk', async (req, res) => {
  const faqs = req.body; // Expecting an array of FAQ objects in the request body

  if (!Array.isArray(faqs) || faqs.length === 0) {
    return res.status(400).json({ error: 'Request body should be an array of FAQs.' });
  }

  try {
    // Insert the array of FAQs into the database
    const insertedFaqs = await Faqs.insertMany(faqs);
    res.status(201).json({
      message: 'FAQs added successfully.',
      data: insertedFaqs,
    });
  } catch (error) {
    console.error('Error adding FAQs:', error);
    res.status(500).json({ error: 'Failed to add FAQs to the database.' });
  }
});
















const testimonialSchema = new mongoose.Schema({
  author: String,
  description:String,
});

const Testimonials = mongoose.model('Testimonials', testimonialSchema);


app.delete('/all/delete/testimonials', async (req, res) => {
  try {
    // Delete all documents from the Faqs collection
    const result = await Testimonials.deleteMany({});
    res.status(200).json({
      message: 'All Testimonials deleted successfully.',
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Error deleting Testimonials:', error);
    res.status(500).json({ error: 'Failed to delete Testimonials from the database.' });
  }
});


app.post('/testimonials', async (req, res) => {
  const { userId, ...testimonialData } = req.body;

  try {
    // Create and save the new testimonial
    const testimonial = new Testimonials(testimonialData);
    await testimonial.save();

    // Update the User's hasSubmittedTestimonial status
    const user = await User.findByIdAndUpdate(
      userId,
      { hasSubmittedTestimonial: true },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.status(201).json({
      success: true,
      data: {
        testimonial,
        user,
      },
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.get('/testimonials', async (req, res) => {
  try {
    const testimonials = await Testimonials.find();
    res.status(200).json({ success: true, data: testimonials });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/testimonials/:id', async (req, res) => {
  try {
    const testimonials = await Testimonials.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!testimonials) return res.status(404).json({ success: false, message: 'testimonials not found' });
    res.status(200).json({ success: true, data: testimonials });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.delete('/testimonials/:id', async (req, res) => {
  try {
    const testimonials = await Testimonials.findByIdAndDelete(req.params.id);
    if (!testimonials) return res.status(404).json({ success: false, message: 'testimonials not found' });
    res.status(200).json({ success: true, message: 'testimonials deleted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});



















const newsSchema = new mongoose.Schema({
  title: String,
  description: String,
  dateCreated: { type: Date, default: Date.now }, // Automatically set the creation date
});

const News = mongoose.model('News', newsSchema);


// Delete all News articles
app.delete('/all/delete/news', async (req, res) => {
  try {
    const result = await News.deleteMany({});
    res.status(200).json({
      message: 'All News articles deleted successfully.',
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Error deleting News:', error);
    res.status(500).json({ error: 'Failed to delete News articles from the database.' });
  }
});




// Add a new News article
app.post('/news', async (req, res) => {
  try {
    // Create and save the news article
    const news = new News(req.body);
    await news.save();

    // Check if notifications are enabled in the request
    if (req.body.notify === 'true' || req.body.notify === true) {
      // Fetch all users with isSubscribed set to true
      const subscribedUsers = await User.find({ isSubscribed: true });

      if (subscribedUsers.length > 0) {
        const emailPromises = subscribedUsers.map(user => {
          const unsubscribeUrl = `https://fantasymmadness-game-server-three.vercel.app/unsubscribe-user/${user._id}`;
          const mailOptions = {
            from: 'Fantasymmadness2@gmail.com',
            to: user.email,
            subject: 'Fantasy mmadness - New Update!',
            html: `
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
                <tr>
                  <td align="center" style="padding: 15px 0;">
                    <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy mmadness Logo" style="width:100px;" />
                    <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy mmadness</h2>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 10px 0;">
                    <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName} ${user.lastName},</p>
                    <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">We have some exciting news for you:</p>
                    <p style="font-size: 20px; font-family: 'Georgia', serif; font-weight: bold; color: #d20a0a; margin-top: 20px; border-bottom: 2px solid #d20a0a; padding-bottom: 5px;">
                      ${news.title}
                    </p>
                    <p style="font-size: 16px; font-family: Arial, sans-serif; line-height: 1.6; color: #555; margin-top: 10px; padding: 10px; background: #f9f9f9; border-radius: 8px; border: 1px solid #ddd;">
                      ${news.description}
                    </p>
                  </td>
                </tr>
                     <!-- Footer Section with Social Icons -->
      <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
                   <p>If you no longer wish to receive updates, you can <a href="${unsubscribeUrl}" style="color: #d20a0a; text-decoration: none;">unsubscribe</a>.</p>
           
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px; width:35px; height:35px; border-radius:50%; background:#fff; background-color:#fff;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%; background-color:#fff; background:#fff;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
          </div>
        </td>
      </tr>
              </table>
            `,
          };

          return transporter.sendMail(mailOptions);
        });

        // Send all emails
        try {
          await Promise.all(emailPromises);
          console.log('Emails sent successfully to subscribed users.');
        } catch (error) {
          console.error('Error sending emails:', error);
        }
      }
    } else {
      console.log('Notification skipped because notify is set to false');
    }

    res.status(201).json({ success: true, message: 'News article added successfully and notifications sent (if applicable).', data: news });
  } catch (error) {
    console.error('Error creating news article:', error);
    res.status(400).json({ success: false, message: error.message });
  }
});

// Unsubscribe a user
app.get('/unsubscribe-user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Update the user's subscription status
    const user = await User.findByIdAndUpdate(userId, { isSubscribed: false }, { new: true });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.send(`
      <div style="text-align: center; font-family: Arial, sans-serif; margin-top: 50px;">
        <h1 style="color: #d20a0a;">Unsubscribed Successfully</h1>
        <p style="font-size: 16px; color: #333;">You will no longer receive notifications from Fantasy Madness.</p>
        <a href="https://fantasymmadness.com" style="text-decoration: none; color: #191164; font-weight: bold;">Return to Fantasy Madness</a>
      </div>
    `);
  } catch (error) {
    console.error('Error unsubscribing user:', error);
    res.status(500).json({ success: false, message: 'An error occurred while unsubscribing the user.' });
  }
});




// Get all News articles
app.get('/news', async (req, res) => {
  try {
    const newsArticles = await News.find();
    res.status(200).json({ success: true, data: newsArticles });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Update a News article by ID
app.put('/news/:id', async (req, res) => {
  try {
    const news = await News.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!news) return res.status(404).json({ success: false, message: 'News article not found' });
    res.status(200).json({ success: true, data: news });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete a News article by ID
app.delete('/news/:id', async (req, res) => {
  try {
    const news = await News.findByIdAndDelete(req.params.id);
    if (!news) return res.status(404).json({ success: false, message: 'News article not found' });
    res.status(200).json({ success: true, message: 'News article deleted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});




















const sponsorSchema = new mongoose.Schema({
  name: String,
  email: String,
  description: String,
  image: String,
  imageDeleteUrl: String,
  websiteLink: String,
  instaLink: String,
  dateCreated: { type: Date, default: Date.now }, // Automatically set the creation date
});

const Sponsors = mongoose.model('Sponsors', sponsorSchema);

// Get all sponsors by email
app.get('/sponsors/email/:email', async (req, res) => {
  try {
    const { email } = req.params; // Extract email from the request parameters

    // Find all sponsors with the given email
    const sponsors = await Sponsors.find({ email });

    if (sponsors.length === 0) {
      return res.status(404).json({ success: false, message: 'No sponsors found for the given email' });
    }

    res.status(200).json({ success: true, data: sponsors });
  } catch (error) {
    console.error('Error fetching sponsors by email:', error);
    res.status(500).json({ success: false, message: 'An error occurred while fetching sponsors' });
  }
});


app.delete('/all/delete/sponsors', async (req, res) => {
  try {
    const result = await Sponsors.deleteMany({});
    res.status(200).json({
      message: 'All Sponsors articles deleted successfully.',
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Error deleting Sponsors:', error);
    res.status(500).json({ error: 'Failed to delete Sponsors articles from the database.' });
  }
});



// POST route to upload sponsor
app.post('/upload-sponsor', upload.single('image'), async (req, res) => {
  try {
    const { name, description, websiteLink, instaLink, email } = req.body; // Extract sponsor data

    // Check if the sponsor already exists
    const existingSponsor = await Sponsors.findOne({ email });
    if (existingSponsor) {
      return res.status(400).json({ message: 'Sponsor with this email already exists.' });
    }

    // Ensure image is provided
    if (!req.file) {
      return res.status(400).json({ error: 'Image is required' });
    }

    // Upload image to Cloudinary
    let imageUrl = '';
    let imageDeleteUrl = '';
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'sponsors' },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      ).end(req.file.buffer);
    });

    imageUrl = result.secure_url;
    imageDeleteUrl = result.public_id;

    // Save sponsor details in the database
    const newSponsor = new Sponsors({
      name,
      description,
      email,
      image: imageUrl,
      imageDeleteUrl: imageDeleteUrl,
      websiteLink,
      instaLink,
    });

    await newSponsor.save();

    const emailContent = `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:100px;" />
            <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0;">
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${name},</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              Thank you for supporting Fantasy Madness! We have successfully added the following information to our website:
            </p>
            <ul style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              <li><strong>Name:</strong> ${name}</li>
              <li><strong>Description:</strong> ${description}</li>
              <li><strong>Website Link:</strong> <a href="${websiteLink}" style="color: #191164; text-decoration: none;">${websiteLink}</a></li>
              <li><strong>Instagram Link:</strong> <a href="${instaLink}" style="color: #191164; text-decoration: none;">${instaLink}</a></li>
              <li>You can use this email:<strong>${email}</strong> to access the sponsor dashboard </li>
           
              </ul>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              If you have any questions or updates, feel free to contact us.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding: 20px 0;">
            <img src="https://i.ibb.co/mF88zvd/Image-5-removebg-preview.png" alt="Fantasy Madness Logo" style="width:70px;" />
            <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>   
            <div style="padding-top: 10px;">
              <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px;">
                <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%;" />
              </a>
              <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
                <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%;" />
              </a>
              <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
                <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%;" />
              </a>
            </div>
          </td>
        </tr>
      </table>
    `;

    await transporter.sendMail({
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: email,
      subject: 'Welcome to Fantasy Madness!',
      html: emailContent,
    });

    res.status(200).json({ message: 'Sponsor uploaded, saved successfully, and email sent', sponsor: newSponsor });
  } catch (error) {
    console.error('Error uploading sponsor:', error);
    res.status(500).json({ error: 'An error occurred while uploading the sponsor' });
  }
});


// Get all News articles
app.get('/sponsors', async (req, res) => {
  try {
    const sponsorArticles = await Sponsors.find();
    res.status(200).json({ success: true, data: sponsorArticles });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// PUT route to update a sponsor by ID
app.put('/sponsor/:id', upload.single('image'), async (req, res) => {
  try {
    const { name, description, websiteLink, instaLink, email } = req.body; // Extract sponsor data

    // Find the existing sponsor
    const sponsor = await Sponsors.findById(req.params.id);
    if (!sponsor) {
      return res.status(404).json({ success: false, message: 'Sponsor not found' });
    }

    let updatedData = { name, description, websiteLink, instaLink, email };

    // Check if a new image is uploaded
    if (req.file) {
      // Upload the new image to Cloudinary
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder: 'sponsors' },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        ).end(req.file.buffer);
      });

      const newImageUrl = result.secure_url;
      const newPublicId = result.public_id;

      // Delete the old image from Cloudinary if it exists
      if (sponsor.imageDeleteUrl) {
        await cloudinary.uploader.destroy(sponsor.imageDeleteUrl);
      }

      // Add new image details to the update data
      updatedData.image = newImageUrl;
      updatedData.imageDeleteUrl = newPublicId;
    }

    // Update the sponsor in the database
    const updatedSponsor = await Sponsors.findByIdAndUpdate(req.params.id, updatedData, {
      new: true,
      runValidators: true,
    });

    res.status(200).json({ success: true, data: updatedSponsor });
  } catch (error) {
    console.error('Error updating sponsor:', error);
    res.status(400).json({ success: false, message: error.message });
  }
});

// DELETE route to delete a sponsor
app.delete('/sponsor/:id', async (req, res) => {
  try {
    const sponsor = await Sponsors.findByIdAndDelete(req.params.id);
    if (!sponsor) return res.status(404).json({ success: false, message: 'Sponsor not found' });

    // Delete the image from ImgBB
    if (sponsor.imageDeleteUrl) {
      const deleteResponse = await fetch(sponsor.imageDeleteUrl, { method: 'GET' });
      if (!deleteResponse.ok) {
        console.warn('Failed to delete image from ImgBB:', await deleteResponse.text());
      }
    }

    res.status(200).json({ success: true, message: 'Sponsor deleted successfully' });
  } catch (error) {
    console.error('Error deleting sponsor:', error);
    res.status(400).json({ success: false, message: error.message });
  }
});













// Start server
const server = app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
