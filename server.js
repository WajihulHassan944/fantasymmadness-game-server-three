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

const userSchema2 = new mongoose.Schema({
  url: String,
  name: String,
  email: String,
  password: String,
  age: String,
  height: String,
  weight: String
});
const Gameuser2 = new mongoose.model("Gameuser2", userSchema2);


// Define the League schema
const leagueSchema = new mongoose.Schema({
  name: String,
  description: String,
  // Other league fields...
  users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Gameuser2' }],
});

const League = mongoose.model('League', leagueSchema);

app.post('/api/create-league', async (req, res) => {
  const { name, description } = req.body;

  try {
      const newLeague = new League({
          name: name,
          description: description,
          users: [], // Initialize with an empty array of users
      });

      await newLeague.save();

      res.status(201).json({ message: 'League created successfully', league: newLeague });
  } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
  }
});

// Route to fetch all leagues
app.get('/api/get-leagues', async (req, res) => {
  try {
      const leagues = await League.find({});
      res.json({ leagues });
  } catch (error) {
      res.status(500).json({ message: 'Error fetching leagues' });
  }
});

const userLeagueSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'Gameuser2' },
  leagueId: { type: mongoose.Schema.Types.ObjectId, ref: 'League' },
});

const UserLeague = mongoose.model('UserLeague', userLeagueSchema);

app.post('/api/join-league/:userId/:leagueId', async (req, res) => {
  const { userId, leagueId } = req.params;

  try {
      // Create a new UserLeague document to represent the user's league membership
      const userLeague = new UserLeague({
          userId: userId,
          leagueId: leagueId,
      });
      await userLeague.save();

      // Update the League document to add the user to the 'users' array
      await League.findByIdAndUpdate(leagueId, { $push: { users: userId } });

      res.status(200).json({ message: 'User joined the league successfully' });
  } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
  }
});
app.get('/api/check-join-status/:userId/:leagueId', async (req, res) => {
  const { userId, leagueId } = req.params;

  try {
      const userLeague = await UserLeague.findOne({ userId: userId, leagueId: leagueId });

      if (userLeague) {
          res.status(200).json({ joined: true });
      } else {
          res.status(200).json({ joined: false });
      }
  } catch (error) {
      res.status(500).json({ message: 'Internal server error' });
  }
});

// Import required modules and set up your Express app

// Assuming you already have a League and UserLeague model

// Define a new route to get users who have joined a specific league
app.get('/api/get-league-users/:leagueId', async (req, res) => {
  const { leagueId } = req.params;

  try {
    // Find the league by its ID
    const league = await League.findById(leagueId);

    if (!league) {
      return res.status(404).json({ message: 'League not found' });
    }

    // Find user leagues associated with this league
    const userLeagues = await UserLeague.find({ leagueId: leagueId });

    if (!userLeagues || userLeagues.length === 0) {
      return res.status(200).json({ message: 'No users have joined this league', users: [] });
    }

    // Extract user IDs from user leagues
    const userIds = userLeagues.map(userLeague => userLeague.userId);

    // Find users by their IDs
    const users = await Gameuser2.find({ _id: { $in: userIds } });

    if (!users || users.length === 0) {
      return res.status(200).json({ message: 'No users found for this league', users: [] });
    }

    // Respond with the list of users who have joined this league
    res.status(200).json({ message: 'Users who have joined this league', users });
  } catch (error) {
    console.error('Error fetching league users:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});










//Routes
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await Gameuser2.findOne({ email: email });

    if (user) {
      const passwordMatch = await bcrypt.compare(password, user.password);

      if (passwordMatch) {
        const objectId = user._id.toString();
        res.status(200).json({ message: 'Login successful', objectId: objectId });
      } else {
        res.status(401).json({ message: 'Invalid password' });
      }
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});
const multer = require('multer');

// Configure multer for file upload
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

app.post('/api/register', upload.single('image'), async (req, res) => {
  const formData = new FormData();
  const { default: fetch } = await import('node-fetch');
  formData.append('image', req.file.buffer.toString('base64'));

  const response = await fetch('https://api.imgbb.com/1/upload?key=368cbdb895c5bed277d50d216adbfa52', {
    method: 'POST',
    body: formData,
  });

  const data = await response.json();

  const imageUrl = data.data.url;
  const { name, email, password ,age ,height, weight} = req.body; // Destructure title and text from req.body


  try {
    const existingUser = await Gameuser2.findOne({ email: email });

    if (existingUser) {
      res.status(409).json({ message: 'User already exists' });
    } else {
      const hashedPassword = await bcrypt.hash(password, 10); // Hash the password

      const newUser = new Gameuser2({
        url: imageUrl,
        name: name,
        email: email,
        password: hashedPassword,
        age: age,
        height: height,
        weight: weight,
  
      });

      await newUser.save();
      res.status(200).json({ message: 'Registration successful', userName: name , userEmail: email });
    }
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});



// API endpoint to retrieve age, height, and weight by name
app.get('/api/user/:name', async (req, res) => {
  const { name } = req.params;

  try {
    const user = await Gameuser2.findOne({ name });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { age, height, weight } = user;
    res.json({ age, height, weight });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to retrieve all user data by name
app.get('/api/user/leaderboard/:name', async (req, res) => {
  const { name } = req.params;

  try {
    const user = await Gameuser2.findOne({ name });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user); // Send all user data
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Delete a user by ObjectId
app.delete('/api/userToDelete/:objectId', async (req, res) => {
  const { objectId } = req.params;

  try {
    const deletedUser = await Gameuser2.findByIdAndDelete(objectId);

    if (!deletedUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users/:objectId', async (req, res) => {
  const { objectId } = req.params;

  try {
    const user = await Gameuser2.findById(objectId);
    if (user) {
      res.status(200).json(user);
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

// API endpoint to fetch all user data
app.get('/api/get-game-users', async (req, res) => {
  try {
    const users = await Gameuser2.find({});
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching user data' });
  }
});

//Routes for games users end here



app.post("/submit-welcome-note", (req, res) => {
  // Extract the form data from the request body
  const {  userName , userEmail} = req.body;
  console.log(userEmail);
  console.log(userName);
  console.log("test");

  // Send an email with the form details using Nodemailer or your preferred email library
  // Here's an example using Nodemailer
  const nodemailer = require("nodemailer");

// Create a transporter object for sending the email
const transporter = nodemailer.createTransport({
  service: 'gmail',
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: 'vascularbundle43@gmail.com',
    pass: 'gxauudkzvdvhdzbg',
  },
});

const storeMailOptions = {
  from: userEmail,
  to: "vascularbundle43@gmail.com",
  subject: "Fantasy MMAdness",
  html: `
    <h2 style="color: #ff523b;">Fantasy MMAdness</h2>
    <hr style="border: 1px solid #ccc;">
    <p>Another user added</p>
  `,
};

const userMailOptions = {
  from: "wajih786hassan@gmail.com",
  to: userEmail,
  subject: "Fantasy MMAdness",
  html: `
  <h2 style="color: red;">Welcome to Fantasy MMAdness</h2>
  <p>Hello ${userName},</p>
  <p>Thank you for signing up for Fantasy MMAdness! We're excited to have you on board and join our community of MMA enthusiasts.</p>
  <p>With Fantasy MMAdness, you can create and manage your own fantasy MMA leagues, make predictions, and compete with others to prove your MMA knowledge.</p>
  <p>Your journey into the world of MMA fantasy gaming begins now. Get ready for some adrenaline-pumping action and fierce competition!</p>
  <p>If you have any questions or need assistance, don't hesitate to reach out to our support team at support@fantasymmadness.com.</p>
  <p>Once again, welcome to Fantasy MMAdness, ${userName}! Let the battles begin!</p>
  <p>Best regards,</p>
  <p>The Fantasy MMAdness Team</p> 
  `,
};

// Send the email to the store
transporter.sendMail(storeMailOptions, function(error, storeInfo) {
  if (error) {
    console.error(error);
    res.status(500).send("Error sending email to store");
  } else {
    console.log("Email sent to store: " + storeInfo.response);

    // Send the email to the user
    transporter.sendMail(userMailOptions, function(error, userInfo) {
      if (error) {
        console.error(error);
        res.status(500).send("Error sending email to user");
      } else {
        console.log("Email sent to user: " + userInfo.response);
        res.status(200).send("Order submitted successfully");
      }
    });
  }
});

});







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
  
