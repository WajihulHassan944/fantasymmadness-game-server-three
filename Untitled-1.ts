const users = await User.find();
  
  
  const mailPromises = users.map(user => {
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
        <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Time:</strong> ${matchTime}</p>
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
