

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
  
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
app.post('/api/authorize-net/transaction', async (req, res) => {
  const { amount, cardNumber, expirationDate, cardCode, customerId, firstName, lastName, email, address, city, state, zip, country } = req.body;

  // Construct the XML request payload for Authorize.Net
  const payload = {
    $: { 'xmlns': 'AnetApi/xml/v1/schema/AnetApiSchema.xsd' }, // Add namespace
    merchantAuthentication: {
      name: process.env.AUTHORIZE_NET_API_LOGIN_ID,
      transactionKey: process.env.AUTHORIZE_NET_TRANSACTION_KEY,
    },
    transactionRequest: {
      transactionType: 'authCaptureTransaction', // or 'authOnlyTransaction' depending on the use case
      amount: amount,
      payment: {
        creditCard: {
          cardNumber: cardNumber,
          expirationDate: expirationDate,
          cardCode: cardCode,
        },
      },
      order: {
        invoiceNumber: `INV-${new Date().getTime()}`,  // Example for generating a unique invoice number
        description: 'Purchase description here',
      },
      customer: {
        id: customerId, // Optional customer ID for tracking purposes
        email: email,   // User email address
      },
      billTo: {
        firstName: firstName,
        lastName: lastName,
        address: address,
        city: city,
        state: state,
        zip: zip,
        country: country,
      },
      shipTo: { // Optional, if shipping details are different from billing
        firstName: firstName,
        lastName: lastName,
        address: address,
        city: city,
        state: state,
        zip: zip,
        country: country,
      },
   
    },
  };

  const xmlPayload = builder.buildObject(payload);

  try {
    const response = await axios.post('https://apitest.authorize.net/xml/v1/request.api', xmlPayload, {
      headers: {
        'Content-Type': 'application/xml',
      },
    });

    return res.send(response.data);
  } catch (error) {
    console.error('Error sending request to Authorize.Net:', error.response?.data || error.message);
    return res.status(500).json({ message: 'Error processing transaction', error: error.message });
  }
});

