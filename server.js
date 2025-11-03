const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./firebase');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 12345;
const app = express();

//Middleware 
app.use(cors());
app.use(express.json());

const transporter = nodemailer.createTransport({
  service: 'gmail', // or your email service
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // Use app password for Gmail
  },
});

const otpStore = new Map();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP endpoint
app.post('/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Generate OTP
    const otp = generateOTP();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store OTP
    otpStore.set(email, { otp, expiresAt });

    // Send email
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your OTP Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Email Verification</h2>
          <p>Your OTP verification code is:</p>
          <div style="background: #f4f4f4; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
            ${otp}
          </div>
          <p>This code will expire in 10 minutes.</p>
          <p>If you didn't request this code, please ignore this email.</p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);

    console.log(`✅ OTP sent to ${email}`);
    
    res.json({ 
      success: true, 
      message: 'OTP sent successfully',
      expiresIn: '10 minutes'
    });
  } catch (error) {
    console.error('❌ Error sending OTP:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to send OTP' 
    });
  }
});

// Verify OTP endpoint
app.post('/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' });
    }

    const storedData = otpStore.get(email);

    if (!storedData) {
      return res.status(400).json({ 
        success: false, 
        error: 'OTP not found or expired' 
      });
    }

    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(email);
      return res.status(400).json({ 
        success: false, 
        error: 'OTP has expired' 
      });
    }

    if (storedData.otp !== otp) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid OTP' 
      });
    }

    // OTP is valid - remove it from store
    otpStore.delete(email);

    console.log(`✅ OTP verified for ${email}`);
    
    res.json({ 
      success: true, 
      message: 'Email verified successfully' 
    });
  } catch (error) {
    console.error('❌ Error verifying OTP:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to verify OTP' 
    });
  }
});

// Resend OTP endpoint
app.post('/auth/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Remove any existing OTP for this email
    otpStore.delete(email);

    // Call the send OTP endpoint logic
    const otp = generateOTP();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    otpStore.set(email, { otp, expiresAt });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Your New OTP Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Email Verification</h2>
          <p>Your new OTP verification code is:</p>
          <div style="background: #f4f4f4; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
            ${otp}
          </div>
          <p>This code will expire in 10 minutes.</p>
          <p>If you didn't request this code, please ignore this email.</p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);

    console.log(`✅ New OTP sent to ${email}`);
    
    res.json({ 
      success: true, 
      message: 'New OTP sent successfully',
      expiresIn: '10 minutes'
    });
  } catch (error) {
    console.error('❌ Error resending OTP:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to resend OTP' 
    });
  }
});

app.post('/auth/custom-token', async (req, res) => {
  try {
    const { uid, email } = req.body;

    if (!uid || !email) {
      return res.status(400).json({ error: 'UID and email are required' });
    }

    console.log('Generating custom token for UID:', uid);

    // Optional: verify the user exists in Firestore
    const userRef = await db.collection('users').doc(uid).get();
    if (!userRef.exists) {
      console.warn(`⚠️ No Firestore user found for UID: ${uid}, creating one`);
      await db.collection('users').doc(uid).set({
        uid,
        email,
        createdAt: new Date(),
      });
    }

    // Create custom token
    const customToken = await admin.auth().createCustomToken(uid, { email });
    console.log('✅ Custom token created successfully');
    
    res.json({ success: true, token: customToken });
  } catch (error) {
    console.error('❌ Error generating custom token:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/save-token', async (req, res) => {
  try {
    const { token, userType = 'user', userData = {} } = req.body;
    
    console.log('Received token save request:', { 
      token, 
      userType,
      userData,
      timestamp: new Date().toISOString()
    });
    
    const tokenData = {
      token, 
      userType, // 'user' or 'admin'
      userData,
      platform: 'android',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...userData
    };
    
    // Use different collection or add role-based filtering
    const collectionName = userType === 'admin' ? 'adminTokens' : 'userTokens';
    const docId = userData.uid || token;
    
    await db.collection(collectionName).doc(docId).set(tokenData, { merge: true });
    
    console.log(`✅ ${userType} token saved successfully`);
    
    return res.status(200).json({ 
      success: true, 
      message: `${userType} token saved successfully`,
      docId: docId
    });
  } catch (error) {
    console.error('Error saving token:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

app.post('/send-notifications', async (req, res) => {
  try {
    const snapshot = await db.collection('expoTokens').get();
    const messages = [];

    snapshot.forEach(doc => {
      messages.push({
        to: doc.data().token,
        sound: 'default',
        title: 'Booking App',
        body: 'This is a test notification!',
        data: { extraData: 'Some data' },
      });
    });

    // Expo recommends sending notifications in **batches** of 100
    const chunks = [];
    for (let i = 0; i < messages.length; i += 100) {
      chunks.push(messages.slice(i, i + 100));
    }

    for (const chunk of chunks) {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      });
    }

    return res.status(200).json({ success: true, sent: messages.length });
  } catch (error) {
    console.error('Error sending notifications:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});


// Add this endpoint to your backend
app.post('/send-admin-notification', async (req, res) => {
  try {
    const { title, message, data = {}, userType = 'admin' } = req.body;
    
    console.log('Sending admin notification:', { title, message, userType });
    
    if (!title || !message) {
      return res.status(400).json({ error: "Title and message required" });
    }
    
    // Get all admin tokens
    let tokensSnapshot;
    if (userType === 'admin') {
      tokensSnapshot = await db.collection('adminTokens').get();
    } else {
      // Or get all tokens (both users and admins)
      tokensSnapshot = await db.collection('expoTokens').get();
    }
    
    const tokens = [];
    tokensSnapshot.forEach(doc => {
      const tokenData = doc.data();
      if (tokenData.token) {
        tokens.push(tokenData.token);
      }
    });
    
    if (tokens.length === 0) {
      console.log('No tokens found for userType:', userType);
      return res.status(404).json({ error: "No tokens found" });
    }
    
    console.log(`Sending notification to ${tokens.length} ${userType}(s)`);
    
    // Prepare messages
    const messages = tokens.map(token => ({
      to: token,
      sound: 'default',
      title: title,
      body: message,
      data: {
        ...data,
        type: 'booking_notification',
        timestamp: new Date().toISOString()
      },
    }));
    
    // Send in batches of 100 (Expo recommendation)
    const chunks = [];
    for (let i = 0; i < messages.length; i += 100) {
      chunks.push(messages.slice(i, i + 100));
    }
    
    let sentCount = 0;
    for (const chunk of chunks) {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 
          'Accept': 'application/json', 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.EXPO_ACCESS_TOKEN}` // Optional if you have one
        },
        body: JSON.stringify(chunk),
      });
      
      const result = await response.json();
      if (result.data) {
        sentCount += result.data.length;
      }
    }
    
    console.log(`✅ Notifications sent successfully to ${sentCount} recipients`);
    
    return res.status(200).json({ 
      success: true, 
      sent: sentCount,
      message: `Notifications sent to ${sentCount} ${userType}(s)`
    });
    
  } catch (error) {
    console.error('❌ Error sending admin notifications:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// Specific endpoint for booking notifications
app.post('/send-booking-notification', async (req, res) => {
  try {
    const { booking, user } = req.body;
    
    console.log('Sending booking notification for:', booking);
    
    if (!booking) {
      return res.status(400).json({ error: "Booking data required" });
    }
    
    // Get all admin tokens
    const tokensSnapshot = await db.collection('adminTokens').get();
    const tokens = [];
    
    tokensSnapshot.forEach(doc => {
      const tokenData = doc.data();
      if (tokenData.token) {
        tokens.push(tokenData.token);
      }
    });
    
    if (tokens.length === 0) {
      console.log('No admin tokens found');
      return res.status(404).json({ error: "No admin tokens found" });
    }
    
    // Create notification message based on booking type
    let title, message;
    
    if (booking.category === 'resorts') {
      title = '🏨 New Resort Booking';
      message = `${booking.userName} booked ${booking.numberOfRooms} room(s) for ${booking.numberOfNights} night(s)`;
    } else if (booking.category === 'tours') {
      title = '🚌 New Tour Booking';
      message = `${booking.userName} booked ${booking.numberOfPeople} people for ${booking.itemName}`;
    } else if (booking.type === 'Restaurant') {
      title = '🍽️ New Restaurant Reservation';
      message = `${booking.userName} reserved for ${booking.numberOfAdults} people`;
    } else {
      title = '📅 New Booking';
      message = `${booking.userName} made a new booking for ${booking.itemName}`;
    }
    
    // Add price information
    message += ` - ${getCurrency(booking.country)}${booking.totalPrice}`;
    
    const messages = tokens.map(token => ({
      to: token,
      sound: 'default',
      title: title,
      body: message,
      data: {
        type: 'new_booking',
        bookingId: booking.id,
        category: booking.category,
        userId: booking.userId,
        userName: booking.userName,
        totalPrice: booking.totalPrice,
        timestamp: new Date().toISOString()
        // deepLink: `yourapp://booking/${booking.id}`
      },
    }));
    
    // Send in batches
    const chunks = [];
    for (let i = 0; i < messages.length; i += 100) {
      chunks.push(messages.slice(i, i + 100));
    }
    
    let sentCount = 0;
    for (const chunk of chunks) {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 
          'Accept': 'application/json', 
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(chunk),
      });
      
      const result = await response.json();
      if (result.data) {
        sentCount += result.data.length;
      }
    }
    
    console.log(`✅ Booking notification sent to ${sentCount} admin(s)`);
    
    return res.status(200).json({ 
      success: true, 
      sent: sentCount,
      message: `Booking notification sent to ${sentCount} admin(s)`
    });
    
  } catch (error) {
    console.error('❌ Error sending booking notification:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

// Helper function to get currency symbol
function getCurrency(country) {
  if (!country) return '$';
  
  switch (country.toLowerCase()) {
    case 'india':
      return '₹';
    case 'united kingdom':
    case 'uk':
    case 'great britain':
      return '£';
    default:
      return '$';
  }
}

app.get('/',(req,res)=>{
    res.send('Backend is running!');
});

app.listen(PORT, ()=> console.log(`server is running on prot ${PORT}`));