const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const app = express();
const { ObjectId } = require('mongodb');
const cors = require("cors");
const FormData = require('form-data');

app.use(express.json());
app.use(cors());



const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;

// MongoDB connection
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const bcrypt = require('bcrypt');





const multer = require('multer');

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
});

const Match = mongoose.model('Match', matchSchema);

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




app.get('/match', async (req, res) => {
  const match = await Match.find();
  res.send(match);
});



app.get("/wajih", (req,res) =>{
  res.send("test completed successfully...");
});



app.get("/", (req,res) =>{
  res.send("Backend server has started running successfully...");
});

const server = app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
  
