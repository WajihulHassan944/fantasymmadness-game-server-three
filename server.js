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











// Define Schema
const scoreSchema = new mongoose.Schema({
  playerName: String,
  matchId:String,
  playerRound: Number,
  hpPrediction1: Number,
  hpPrediction2: Number,
  bpPrediction1: Number,
  bpPrediction2: Number,
  tpPrediction1: Number,
  tpPrediction2: Number,
  rwPrediction1: Number,
  rwPrediction2: Number,
  koPrediction1: Number,
  koPrediction2: Number,
});

const Score = mongoose.model('Score', scoreSchema);
app.post('/api/scores', async (req, res) => {
  try {
    const {
      playerName,
      matchId,
      playerRound,
      hpPrediction1,
      bpPrediction1,
      hpPrediction2,
      bpPrediction2,
      tpPrediction1,
      tpPrediction2,
      rwPrediction1,
      rwPrediction2,
      koPrediction1,
      koPrediction2,
    } = req.body;

    // Check if there's an existing record with the same playerName, matchId, and playerRound
    let existingScore = await Score.findOne({ playerName, matchId, playerRound });

    if (existingScore) {
      // If a record exists, update its values
      existingScore.hpPrediction1 = hpPrediction1;
      existingScore.bpPrediction1 = bpPrediction1;
      existingScore.hpPrediction2 = hpPrediction2;
      existingScore.bpPrediction2 = bpPrediction2;
      existingScore.tpPrediction1 = tpPrediction1;
      existingScore.tpPrediction2 = tpPrediction2;
      existingScore.rwPrediction1 = rwPrediction1;
      existingScore.rwPrediction2 = rwPrediction2;
      existingScore.koPrediction1 = koPrediction1;
      existingScore.koPrediction2 = koPrediction2;

      // Save the updated record
      await existingScore.save();
      res.status(200).send(existingScore);
    } else {
      // If no record exists, create a new one
      const score = new Score({
        playerName,
        matchId,
        playerRound,
        hpPrediction1,
        bpPrediction1,
        hpPrediction2,
        bpPrediction2,
        tpPrediction1,
        tpPrediction2,
        rwPrediction1,
        rwPrediction2,
        koPrediction1,
        koPrediction2,
      });

      // Save the new record
      await score.save();
      res.status(201).send(score);
    }
  } catch (error) {
    res.status(400).send(error);
  }
});

app.delete('/api/scores/:playerName', async (req, res) => {
  const playerName = req.params.playerName;

  try {
    const result = await Score.deleteMany({ playerName });

    if (result.deletedCount > 0) {
      res.status(200).json({ message: `Deleted ${result.deletedCount} records for ${playerName}` });
    } else {
      res.status(404).json({ message: `No records found for ${playerName}` });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal server error' });
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





// API endpoint to delete a score by ID
app.delete('/api/scores/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if the provided ID is valid
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).send('Invalid ID format');
    }

    // Find the score by ID and delete it
    const deletedScore = await Score.findByIdAndDelete(id);

    if (!deletedScore) {
      return res.status(404).send('Score not found');
    }

    res.status(200).send(deletedScore);
  } catch (error) {
    res.status(500).send(error);
  }
});







// for mma

const scoreSchemamma = new mongoose.Schema({
  playerName: String,
  matchId:String,
  playerRound: Number,
  stPrediction1: Number,
  stPrediction2: Number,
  kiPrediction1: Number,
  kiPrediction2: Number,
  knPrediction1: Number,
  knPrediction2: Number,
  elPrediction1: Number,
  elPrediction2: Number,
  spPrediction1: Number,
  spPrediction2: Number,
  rwPrediction1: Number,
  rwPrediction2: Number,
});

const ScoreMma = mongoose.model('ScoreMma', scoreSchemamma);

app.delete('/api/mma/scores/:playerName', async (req, res) => {
  const playerName = req.params.playerName;

  try {
    const result = await ScoreMma.deleteMany({ playerName });

    if (result.deletedCount > 0) {
      res.status(200).json({ message: `Deleted ${result.deletedCount} records for ${playerName}` });
    } else {
      res.status(404).json({ message: `No records found for ${playerName}` });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/api/mma/scores', async (req, res) => {
  try {
    const {
      playerName,
      matchId,
      playerRound,
      stPrediction1,
      stPrediction2,
      kiPrediction1,
      kiPrediction2,
      knPrediction1,
      knPrediction2,
      elPrediction1,
      elPrediction2,
      spPrediction1,
      spPrediction2,
      rwPrediction1,
      rwPrediction2,
    } = req.body;

    // Check if there's an existing record with the same playerName, matchId, and playerRound
    let existingMmaScore = await ScoreMma.findOne({ playerName, matchId, playerRound });

    if (existingMmaScore) {
      // If a record exists, update its values
      existingMmaScore.stPrediction1 = stPrediction1;
      existingMmaScore.stPrediction2 = stPrediction2;
      existingMmaScore.kiPrediction1 = kiPrediction1;
      existingMmaScore.kiPrediction2 = kiPrediction2;
      existingMmaScore.knPrediction1 = knPrediction1;
      existingMmaScore.knPrediction2 = knPrediction2;
      existingMmaScore.elPrediction1 = elPrediction1;
      existingMmaScore.elPrediction2 = elPrediction2;
      existingMmaScore.spPrediction1 = spPrediction1;
      existingMmaScore.spPrediction2 = spPrediction2;
      existingMmaScore.rwPrediction1 = rwPrediction1;
      existingMmaScore.rwPrediction2 = rwPrediction2;

      // Save the updated record
      await existingMmaScore.save();
      res.status(200).send(existingMmaScore);
    } else {
      // If no record exists, create a new one
      const scoreMma = new ScoreMma({
        playerName,
        matchId,
        playerRound,
        stPrediction1,
        stPrediction2,
        kiPrediction1,
        kiPrediction2,
        knPrediction1,
        knPrediction2,
        elPrediction1,
        elPrediction2,
        spPrediction1,
        spPrediction2,
        rwPrediction1,
        rwPrediction2,
      });

      // Save the new record
      await scoreMma.save();
      res.status(201).send(scoreMma);
    }
  } catch (error) {
    res.status(400).send(error);
  }
});

// API endpoint to retrieve MMA scores
app.get('/api/mma/scores', async (req, res) => {
  try {
    const scoresMma = await ScoreMma.find();
    res.send(scoresMma);
  } catch (error) {
    res.status(500).send(error);
  }
});




//code for blogs start



const blogsSchema = new mongoose.Schema({
  url: String,
  title: String,
  text: String,
  blogDate: Date
});

const Blogs = mongoose.model('Blogs', blogsSchema);

app.post('/uploadBlogFmma', upload.single('image'), async (req, res) => {
  const formData = new FormData();
  const { default: fetch } = await import('node-fetch');
  formData.append('image', req.file.buffer.toString('base64'));

  const response = await fetch('https://api.imgbb.com/1/upload?key=368cbdb895c5bed277d50d216adbfa52', {
    method: 'POST',
    body: formData,
  });

  const data = await response.json();

  const imageUrl = data.data.url;
  const { title, text , blogDate } = req.body; // Destructure title and text from req.body

  // Save the image URL, title, and text to the database
  const newBlog = new Blogs({ url: imageUrl, title: title, text: text, blogDate: blogDate });
  await newBlog.save();
  res.status(200).send('Blog uploaded successfully');
});


app.get('/blogFmma/:objectId', async (req, res) => {
  const { objectId } = req.params;

  try {
    const user = await Blogs.findById(objectId);
    if (user) {
      res.status(200).json(user);
    } else {
      res.status(404).json({ message: 'Blog not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});


app.delete('/blogtodeleteFmma/:id', async (req, res) => {
  const { id } = req.params;
  console.log('Received DELETE request for blog ID:', id);
  try {
    const blog = await Blogs.findByIdAndDelete(id);
    
    res.status(200).json({ message: 'Data deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});



// Define route for fetching images
app.get('/blogsFmma', async (req, res) => {
  const images = await Blogs.find();
  res.send(images);
});




//code for blogs end



//code for feedback start

const feedbacksSchema = new mongoose.Schema({
  feedback: String,
  userUrl: String,
  userName: String,
  matchId: String,
});

const Feedback = mongoose.model('Feedback', feedbacksSchema);


app.post('/uploadFeedback', async (req, res) => {
  const { feedback, userUrl, userName, matchId } = req.body;

  try {
    // Check if the user with the given username has already submitted feedback for this match
    const existingFeedback = await Feedback.findOne({ matchId: matchId, userName: userName });
    
    if (existingFeedback) {
      // If the feedback already exists for this match and user, return a message
      return res.status(400).send('Feedback already exists for this match and user');
    }

    // If the feedback doesn't exist for this match and user, save the feedback to the database
    const newFeedback = new Feedback({ feedback: feedback, userUrl: userUrl, userName: userName, matchId: matchId });
    await newFeedback.save();

    res.status(200).send('Feedback saved successfully');
  } catch (error) {
    console.error('Error saving feedback:', error);
    res.status(500).send('Internal server error');
  }
});





// Define route for fetching images
app.get('/feedbacks', async (req, res) => {
  const images = await Feedback.find();
  res.send(images);
});


//code for feedback end







//code for globalLeaderBoard start

const globalLeaderBoardSchema = new mongoose.Schema({
  usersName: String,
  totalPoint: String,
  matchId: String,
  matchType: String,
});

const GlobalLeaderBoard = mongoose.model('GlobalLeaderBoard', globalLeaderBoardSchema);


app.post('/globalLeaderBoard', async (req, res) => {
  const { usersName, totalPoint, matchId, matchType } = req.body;

  try {
    // Check if there is an existing entry with the same user name, total points, and match type
    const existingEntry = await GlobalLeaderBoard.findOne({ usersName: usersName, totalPoint: totalPoint, matchId: matchId, matchType: matchType });

    // If an existing entry is found, return a message indicating the duplicate
    if (existingEntry) {
      console.log("existing entry for  global leaderboard");
      return res.status(400).send('Duplicate entry detected');
      
    } else {
      // If no duplicate entry found, save the new entry to the database
      const newGlobalLeaderBoard = new GlobalLeaderBoard({ usersName: usersName, totalPoint: totalPoint, matchId: matchId, matchType: matchType });
      await newGlobalLeaderBoard.save();

      res.status(200).send('Scores saved successfully');
    }
  } catch (error) {
    console.error('Error saving scores:', error);
    res.status(500).send('Internal server error');
  }
});




// Define route for fetching images
app.get('/api/globalLeaderBoard', async (req, res) => {
  const images = await GlobalLeaderBoard.find();
  res.send(images);
});


//code for globalLeaderBoard end





app.get("/", (req,res) =>{
  res.send("Backend server has started running successfully...");
});

const server = app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
  
