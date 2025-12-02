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


// Add Stripe import at the top
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Add this endpoint after your existing endpoints (before app.listen)
// Add this endpoint for debugging
app.get('/api-debug', (req, res) => {
  res.json({
    success: true,
    message: 'Backend is working',
    timestamp: new Date().toISOString(),
    endpoints: {
      root: '/',
      paymentHealth: '/payment-health',
      createPaymentIntent: '/create-payment-intent',
      confirmPayment: '/confirm-payment',
      auth: {
        sendOtp: '/auth/send-otp',
        verifyOtp: '/auth/verify-otp',
        customToken: '/auth/custom-token'
      }
    },
    env: {
      port: process.env.PORT,
      stripeKey: process.env.STRIPE_SECRET_KEY ? 'set' : 'not set',
      emailUser: process.env.EMAIL_USER ? 'set' : 'not set'
    }
  });
});

// Also update your payment-health endpoint to ensure it exists:
app.get('/payment-health', (req, res) => {
  res.json({
    success: true,
    message: 'Payment service is running',
    timestamp: new Date().toISOString(),
    stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'not configured',
    endpoints: ['/create-payment-intent', '/confirm-payment']
  });
});
// Create Payment Intent endpoint
app.post('/create-payment-intent', async (req, res) => {
  try {
    console.log('📱 Creating payment intent...');
    const { 
      amount, 
      currency = 'inr',
      customerEmail, 
      metadata = {},
      country = 'India' 
    } = req.body;
    
    console.log('Payment request data:', { amount, currency, country, customerEmail });
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Valid amount is required' 
      });
    }

    // Determine currency based on country
    let finalCurrency = currency.toLowerCase();
    if (country) {
      const countryLower = country.toLowerCase();
      if (countryLower.includes('india')) {
        finalCurrency = 'inr';
      } else if (countryLower.includes('uk') || countryLower.includes('united kingdom')) {
        finalCurrency = 'gbp';
      } else if (countryLower.includes('us') || countryLower.includes('usa') || countryLower.includes('united states')) {
        finalCurrency = 'usd';
      }
    }

    // Validate currency is supported by Stripe
    const supportedCurrencies = ['inr', 'gbp', 'usd', 'eur', 'aud', 'cad'];
    if (!supportedCurrencies.includes(finalCurrency)) {
      return res.status(400).json({ 
        success: false,
        error: `Currency ${finalCurrency} is not supported. Supported currencies: ${supportedCurrencies.join(', ')}` 
      });
    }

    // Convert amount to smallest currency unit
    let amountInSmallestUnit;
    if (finalCurrency === 'inr') {
      // INR uses paisa (100 paisa = 1 rupee)
      amountInSmallestUnit = Math.round(amount * 100);
    } else if (finalCurrency === 'gbp') {
      // GBP uses pence (100 pence = 1 pound)
      amountInSmallestUnit = Math.round(amount * 100);
    } else if (finalCurrency === 'usd') {
      // USD uses cents (100 cents = 1 dollar)
      amountInSmallestUnit = Math.round(amount * 100);
    } else {
      amountInSmallestUnit = Math.round(amount * 100);
    }

    // Minimum amount validation
    const minimumAmounts = {
      'inr': 50,   // 0.50 INR
      'gbp': 30,   // 0.30 GBP
      'usd': 50,   // 0.50 USD
    };

    if (minimumAmounts[finalCurrency] && amountInSmallestUnit < minimumAmounts[finalCurrency]) {
      return res.status(400).json({ 
        success: false,
        error: `Minimum amount for ${finalCurrency.toUpperCase()} is ${minimumAmounts[finalCurrency]/100}` 
      });
    }

    console.log(`Creating payment intent: ${amountInSmallestUnit} ${finalCurrency}`);
    
    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInSmallestUnit,
      currency: finalCurrency,
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        ...metadata,
        customerEmail: customerEmail || '',
        country: country || '',
        originalAmount: amount,
        timestamp: new Date().toISOString()
      }
    });

    console.log('✅ Payment Intent created:', paymentIntent.id);
    
    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: amountInSmallestUnit / 100,
      currency: finalCurrency.toUpperCase(),
      displayAmount: amount
    });
    
  } catch (error) {
    console.error('❌ Error creating payment intent:', error);
    
    res.status(500).json({ 
      success: false, 
      error: error.message,
      errorCode: error.code,
      errorType: error.type
    });
  }
});

// Confirm payment endpoint
app.post('/confirm-payment', async (req, res) => {
  try {
    console.log('📱 Confirming payment...');
    const { paymentIntentId, bookingData } = req.body;
    
    console.log('Confirming payment intent:', paymentIntentId);
    
    if (!paymentIntentId) {
      return res.status(400).json({ 
        success: false,
        error: 'Payment Intent ID is required' 
      });
    }

    // Retrieve payment intent to confirm status
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    console.log('Payment Intent status:', paymentIntent.status);
    
    let bookingStatus = 'pending';
    let message = 'Payment processing';
    
    if (paymentIntent.status === 'succeeded') {
      bookingStatus = 'confirmed';
      message = 'Payment successful';
      
      // If booking data is provided, create booking in Firestore
      if (bookingData) {
        try {
          console.log('✅ Creating booking after successful payment');
          
          // Save booking to Firestore
          const bookingRef = await db.collection('bookings').add({
            ...bookingData,
            paymentIntentId: paymentIntentId,
            paymentStatus: 'succeeded',
            paymentAmount: paymentIntent.amount / 100,
            paymentCurrency: paymentIntent.currency,
            paymentDate: new Date().toISOString(),
            status: 'confirmed',
            createdAt: new Date(),
            updatedAt: new Date()
          });
          
          console.log('✅ Booking created with ID:', bookingRef.id);
          
        } catch (bookingError) {
          console.error('❌ Error creating booking:', bookingError);
        }
      }
    } else if (paymentIntent.status === 'processing') {
      bookingStatus = 'processing';
      message = 'Payment is processing';
    } else if (paymentIntent.status === 'requires_action' || paymentIntent.status === 'requires_confirmation') {
      bookingStatus = 'requires_action';
      message = 'Payment requires additional action';
    } else if (paymentIntent.status === 'canceled' || paymentIntent.status === 'requires_payment_method') {
      bookingStatus = 'failed';
      message = 'Payment failed or was canceled';
    }
    
    res.json({
      success: paymentIntent.status === 'succeeded',
      status: paymentIntent.status,
      bookingStatus,
      message,
      paymentIntent: {
        id: paymentIntent.id,
        amount: paymentIntent.amount / 100,
        currency: paymentIntent.currency,
        created: new Date(paymentIntent.created * 1000),
        metadata: paymentIntent.metadata
      }
    });
    
  } catch (error) {
    console.error('❌ Error confirming payment:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Health check endpoint for payment service
app.get('/payment-health', (req, res) => {
  res.json({
    success: true,
    message: 'Payment service is running',
    timestamp: new Date().toISOString(),
    stripe: 'connected'
  });
});
// Helper function to get statement descriptor based on currency
function getStatementDescriptor(currency, itemName) {
  const descriptors = {
    'inr': 'GH_IND',
    'gbp': 'GH_UK',
    'usd': 'GH_US',
    'default': 'GH_BOOKING'
  };
  
  return descriptors[currency] || descriptors.default;
}

// Helper function to format currency for display
function formatCurrency(amount, currency) {
  const symbols = {
    'inr': '₹',
    'gbp': '£',
    'usd': '$',
    'eur': '€',
    'aud': 'A$',
    'cad': 'C$'
  };
  
  const symbol = symbols[currency.toLowerCase()] || '$';
  
  // Format number with appropriate decimal places
  const formattedAmount = parseFloat(amount).toFixed(2);
  
  // For INR, use Indian numbering system (add commas)
  if (currency.toLowerCase() === 'inr') {
    return `₹ ${formatIndianNumber(formattedAmount)}`;
  }
  
  return `${symbol}${formattedAmount}`;
}

// Helper function for Indian number formatting
function formatIndianNumber(num) {
  const numStr = num.toString();
  const parts = numStr.split('.');
  let integerPart = parts[0];
  const decimalPart = parts[1] ? `.${parts[1]}` : '';
  
  // Indian numbering system: 1,23,456.78
  const lastThree = integerPart.slice(-3);
  const otherNumbers = integerPart.slice(0, -3);
  if (otherNumbers !== '') {
    return otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + lastThree + decimalPart;
  }
  return lastThree + decimalPart;
}

// Get supported currencies endpoint
app.get('/supported-currencies', (req, res) => {
  const supportedCurrencies = [
    {
      code: 'INR',
      symbol: '₹',
      name: 'Indian Rupee',
      country: 'India',
      minimumAmount: 0.50,
      stripeSupported: true
    },
    {
      code: 'GBP',
      symbol: '£',
      name: 'British Pound',
      country: 'United Kingdom',
      minimumAmount: 0.30,
      stripeSupported: true
    },
    {
      code: 'USD',
      symbol: '$',
      name: 'US Dollar',
      country: 'United States',
      minimumAmount: 0.50,
      stripeSupported: true
    }
  ];
  
  res.json({
    success: true,
    currencies: supportedCurrencies
  });
});

// Get currency based on country endpoint
app.post('/get-currency', (req, res) => {
  const { country } = req.body;
  
  if (!country) {
    return res.status(400).json({ error: 'Country is required' });
  }
  
  const countryLower = country.toLowerCase();
  let currency = 'usd';
  let symbol = '$';
  
  if (countryLower.includes('india')) {
    currency = 'inr';
    symbol = '₹';
  } else if (countryLower.includes('uk') || countryLower.includes('united kingdom') || countryLower.includes('britain')) {
    currency = 'gbp';
    symbol = '£';
  } else if (countryLower.includes('us') || countryLower.includes('usa') || countryLower.includes('united states')) {
    currency = 'usd';
    symbol = '$';
  } else if (countryLower.includes('euro') || countryLower.includes('eu')) {
    currency = 'eur';
    symbol = '€';
  }
  
  res.json({
    success: true,
    currency,
    symbol,
    country: country
  });
});

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
