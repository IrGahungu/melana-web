// server.js
const express = require("express");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
require("dotenv").config();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { getPool } = require("./db"); // 👈 Import from our new db.js file

const app = express();
const cors = require("cors");
app.use(cors());
app.use(bodyParser.json());

// -----------------------------
// Config
// -----------------------------
const pool = getPool(); // 👈 Get the shared pool instance
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";

// -----------------------------
// Middleware → Auth
// -----------------------------
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    console.warn(`[Auth] 401 Unauthorized: No Authorization header provided for ${req.path}`);
    return res.status(401).json({ error: "No token" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.sub, fullname: decoded.fullname, username: decoded.username, role: decoded.role };
    next();
  } catch (err) {
    console.error(`[Auth] 401 Unauthorized: Invalid token for ${req.path}. Error: ${err.message}`);
    return res.status(401).json({ error: "Invalid token" });
  }
};
const adminOnly = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Access denied. Admins only." });
  }
  next();
};

// -----------------------------
// REGISTER
// -----------------------------
// -----------------------------
// REGISTER
// -----------------------------
app.post("/register", async (req, res) => {
  const {
    fullname,
    password,
    whatsapp_number,
    gender,
    country,
    secret_question,
    secret_answer,
  } = req.body;

  // Validate required fields
  if (!fullname || !password || !whatsapp_number || !gender || !country || !secret_question || !secret_answer) {
    return res.status(400).json({ error: "All fields are required, including the secret question." });
  }

  // Password validation: ≥8 chars, letters & numbers
  const passwordRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/;
  if (!passwordRegex.test(password)) {
    return res.status(400).json({
      error: "Password must be at least 8 characters and include letters and numbers",
    });
  }

  try {
    // Check if WhatsApp number is unique
    const existing = await pool.query(
      "SELECT id FROM users WHERE whatsapp_number=$1",
      [whatsapp_number]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "WhatsApp number already registered" });
    }

    // Hash the password
    const hashed = password;

    // Insert the new user with default wallet balance
    const result = await pool.query( // Assuming 'username' column is added to users table
      `INSERT INTO users
         (fullname, password, whatsapp_number, gender, country, secret_question, secret_answer, wallet_balance, pin_code, engagement_points, username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
       RETURNING id, fullname, whatsapp_number, gender, country, created_at, wallet_balance, engagement_points, username`,
      [fullname, hashed, whatsapp_number, gender, country, secret_question, secret_answer, 1000000, '1616', 0]
    );

    const newUser = result.rows[0];

    // Also generate a token on registration to log the user in immediately
    const token = jwt.sign(
      {
        aud: 'authenticated', // Standard Supabase claim
        exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7), // 7 days
        sub: newUser.id,
        fullname: newUser.fullname,
        username: newUser.username, // Include username in token
        role: 'authenticated', // Standard Supabase claim
      },
      JWT_SECRET
    );

    // Respond with the created user
    res.json({ user: newUser, token });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Connection timed out, retry again" });
  }
});


// -----------------------------
// CHECK WHATSAPP
// -----------------------------
app.post("/check-whatsapp", async (req, res) => {
  const { whatsapp_number } = req.body;
  if (!whatsapp_number) return res.status(400).json({ error: "WhatsApp number required" });

  try {
    const result = await pool.query("SELECT id FROM users WHERE whatsapp_number=$1", [whatsapp_number]);
    res.json({ exists: result.rows.length > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// ✅ Health check route
app.get("/", (_req, res) => {
  res.send("Auth server is running! Healthy and ready.");
});

// -----------------------------
// ✅ SYSTEM CONFIGURATION (Publicly accessible, but values are admin-set)
// -----------------------------
app.get("/api/config/bus-booking-threshold", async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'min_ep_required'");
    if (result.rows.length > 0) {
      res.json({ min_ep_required: parseInt(result.rows[0].value, 10) });
    } else {
      // Fallback if not found in DB, though it should be inserted by the SQL above
      res.json({ min_ep_required: 5000 });
    }
  } catch (err) {
    console.error("Config fetch error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// ✅ ADMIN: UPDATE SYSTEM SETTINGS
// -----------------------------
app.get("/api/admin/settings/min-ep-required", authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'min_ep_required'");
    if (result.rows.length > 0) {
      res.json({ min_ep_required: parseInt(result.rows[0].value, 10) });
    } else {
      // Fallback
      res.json({ min_ep_required: 5000 });
    }
  } catch (err) {
    console.error("Admin fetch setting error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

app.put("/api/admin/settings/min-ep-required", authMiddleware, adminOnly, async (req, res) => {
  const { value } = req.body;

  if (value === undefined || isNaN(parseInt(value, 10)) || parseInt(value, 10) < 0) {
    return res.status(400).json({ error: "Invalid value provided. Must be a non-negative number." });
  }

  try {
    const parsedValue = parseInt(value, 10);
    const result = await pool.query(
      "INSERT INTO settings (key, value, description) VALUES ('min_ep_required', $1, 'Minimum engagement points required for bus booking eligibility') ON CONFLICT (key) DO UPDATE SET value = $1 RETURNING *",
      [parsedValue.toString()] // Store as string, parse as int when reading
    );
    res.json({ success: true, updated_setting: result.rows[0] });
  } catch (err) {
    console.error("Admin update setting error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// ✅ ADMIN: MANAGE ENGAGEMENT POINTS
// -----------------------------
app.get("/api/admin/settings/engagement-points", authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT key, value FROM settings 
      WHERE key IN (
        'ep_story_view', 'ep_post_view', 'ep_post_like', 'story_duration',
        'show_add_to_cart_button',
        'show_call_car_button_product',
        'show_call_car_button_doctor',
        'show_call_car_button_hospital',
        'show_call_car_button_insurance',
        'show_call_car_button_pharmacy',
        'show_book_online_button',
        'show_book_in_office_button',
        'show_orders_button',
        'show_my_appointments_button',
        'show_book_bus_button',
        'show_my_bus_tickets_button',
        'monetization_goal'
      )
    `);
    const settings = {};
    result.rows.forEach(row => settings[row.key] = row.value);
    res.json({
      ep_story_view: parseInt(settings.ep_story_view || 500, 10),
      ep_post_view: parseInt(settings.ep_post_view || 300, 10),
      ep_post_like: parseInt(settings.ep_post_like || 200, 10),
      story_duration: parseInt(settings.story_duration || 45000, 10),
      show_add_to_cart_button: settings.show_add_to_cart_button === 'true',
      show_call_car_button_product: settings.show_call_car_button_product === 'true',
      show_call_car_button_doctor: settings.show_call_car_button_doctor === 'true',
      show_call_car_button_hospital: settings.show_call_car_button_hospital === 'true',
      show_call_car_button_insurance: settings.show_call_car_button_insurance === 'true',
      show_call_car_button_pharmacy: settings.show_call_car_button_pharmacy === 'true',
      show_orders_button: settings.show_orders_button === 'true', 
      show_my_appointments_button: settings.show_my_appointments_button === 'true', 
      show_book_bus_button: settings.show_book_bus_button === 'true', 
      show_my_bus_tickets_button: settings.show_my_bus_tickets_button === 'true', 
      monetization_goal: parseInt(settings.monetization_goal || 50000, 10),
      show_book_online_button: settings.show_book_online_button === 'true',
      show_book_in_office_button: settings.show_book_in_office_button === 'true',
    });
  } catch (err) {
    console.error("Fetch EP settings error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// Helper to parse boolean string values
const parseBooleanString = (value) => {
  return value === 'true' ? 'true' : 'false';
};

app.put("/api/admin/settings/engagement-points", authMiddleware, adminOnly, async (req, res) => {
  const { key, value } = req.body;
  const allowed = ['ep_story_view', 'ep_post_view', 'ep_post_like', 'story_duration', 'monetization_goal'];
  
  console.log(`[Server] Received Update Request - Key: ${key}, Value: ${value}`);

  if (!allowed.includes(key)) {
    console.warn(`[Server] Rejected: Key "${key}" is not in the allowed list.`);
    return res.status(400).json({ error: "Invalid key." });
  }

  try {
    if (isNaN(parseInt(value, 10))) {
      console.warn(`[Server] Rejected: Value for "${key}" is not a valid number: ${value}`);
      return res.status(400).json({ error: "Value must be a number." });
    }
    const finalValue = value.toString();

    console.log(`[Server] Executing SQL: UPDATE settings SET value = '${finalValue}' WHERE key = '${key}'`);

    await pool.query(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [key, String(finalValue)]
    );
    
    console.log(`[Server] Database updated successfully for key: ${key}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Update EP setting error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// Dedicated route to toggle Add to Cart visibility
app.put("/api/admin/settings/toggle-cart-button", authMiddleware, adminOnly, async (req, res) => {
  const { isVisible } = req.body;

  if (typeof isVisible !== 'boolean') {
    return res.status(400).json({ error: "isVisible must be a boolean." });
  }

  try {
    const value = isVisible ? 'true' : 'false';
    console.log(`[Server] Toggling Add to Cart button to: ${value}`);

    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('show_add_to_cart_button', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
      [value]
    );

    res.json({ success: true, show_add_to_cart_button: isVisible });
  } catch (err) {
    console.error("Toggle cart button error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// Public config for mobile app
app.get("/api/config/engagement-settings", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT key, value FROM settings 
      WHERE key IN (
        'ep_story_view', 'ep_post_view', 'ep_post_like', 'story_duration', 
        'show_add_to_cart_button',
        'show_call_car_button_product',
        'show_call_car_button_doctor',
        'show_call_car_button_hospital',
        'show_call_car_button_insurance',
        'show_call_car_button_pharmacy',
        'show_book_online_button',
        'show_book_in_office_button',
        'show_orders_button',
        'show_my_appointments_button',
        'show_book_bus_button',
        'show_my_bus_tickets_button',
        'monetization_goal'
      )
    `);
    console.log("[Server] Raw settings rows from DB:", result.rows);
    const settings = {};
    result.rows.forEach(row => settings[row.key] = row.value);
    const config = {
      ep_story_view: parseInt(settings.ep_story_view || 500, 10),
      ep_post_view: parseInt(settings.ep_post_view || 300, 10),
      ep_post_like: parseInt(settings.ep_post_like || 200, 10),
      story_duration: parseInt(settings.story_duration || 45000, 10),
      show_add_to_cart_button: settings.show_add_to_cart_button === 'true',
      show_call_car_button_product: settings.show_call_car_button_product === 'true',
      show_call_car_button_doctor: settings.show_call_car_button_doctor === 'true',
      show_call_car_button_hospital: settings.show_call_car_button_hospital === 'true',
      show_call_car_button_insurance: settings.show_call_car_button_insurance === 'true',
      show_call_car_button_pharmacy: settings.show_call_car_button_pharmacy === 'true',
      show_orders_button: settings.show_orders_button === 'true', // New
      show_my_appointments_button: settings.show_my_appointments_button === 'true',
      show_book_bus_button: settings.show_book_bus_button === 'true', 
      show_my_bus_tickets_button: settings.show_my_bus_tickets_button === 'true',
      monetization_goal: parseInt(settings.monetization_goal || 50000, 10),
      show_book_online_button: settings.show_book_online_button === 'true',
      show_book_in_office_button: settings.show_book_in_office_button === 'true',
    };
    console.log("[Server] Final config sent to app (engagement-settings):", config);
    console.log("[Server] Sending config to app:", config);
    res.json(config);
  } catch (err) {
    console.error("Fetch app EP config error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// Generic route to toggle visibility of various UI elements
app.put("/api/admin/settings/toggle-visibility", authMiddleware, adminOnly, async (req, res) => {
  const { key, isVisible } = req.body;
  const allowed = [
    'show_add_to_cart_button',
    'show_call_car_button_product',
    'show_call_car_button_doctor',
    'show_call_car_button_hospital',
    'show_call_car_button_insurance',
    'show_call_car_button_pharmacy'
  ];
  
  if (!allowed.includes(key)) {
    return res.status(400).json({ error: "Invalid key." });
  }

  if (typeof isVisible !== 'boolean') {
    return res.status(400).json({ error: "isVisible must be a boolean." });
  }

  try {
    const value = isVisible ? 'true' : 'false';
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [key, value]
    );
    res.json({ success: true, [key]: isVisible });
  } catch (err) {
    console.error("Toggle visibility error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// Dedicated route for Call Car / CTA buttons with key mapping
app.put("/api/admin/settings/toggle-button", authMiddleware, adminOnly, async (req, res) => {
  const { key, isVisible } = req.body;

  // Map the keys from ButtonSettings to existing DB settings keys
  const keyMap = {
    'show_product_cta_button': 'show_call_car_button_product',
    'show_doctor_cta_button': 'show_call_car_button_doctor',
    'show_hospital_cta_button': 'show_call_car_button_hospital',
    'show_insurance_cta_button': 'show_call_car_button_insurance',
    'show_pharmacy_cta_button': 'show_call_car_button_pharmacy',
    'show_book_online_button': 'show_book_online_button', 
    'show_book_in_office_button': 'show_book_in_office_button', 
    'show_orders_button': 'show_orders_button', 
    'show_my_appointments_button': 'show_my_appointments_button', 
    'show_book_bus_button': 'show_book_bus_button', 
    'show_my_bus_tickets_button': 'show_my_bus_tickets_button' 
  };

  const dbKey = keyMap[key];

  if (!dbKey) {
    return res.status(400).json({ error: "Invalid button key." });
  }

  if (typeof isVisible !== 'boolean') {
    return res.status(400).json({ error: "isVisible must be a boolean." });
  }

  try {
    const value = isVisible ? 'true' : 'false';
    console.log(`[Server] Toggling CTA Button [${key} -> ${dbKey}] to: ${value}`);

    await pool.query(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [dbKey, value]
    );

    res.json({ success: true, [key]: isVisible });
  } catch (err) {
    console.error("Toggle button error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// ✅ LOGIN (fixed)
// -----------------------------
app.post("/login", async (req, res) => {
  console.log("Login request body:", req.body);
  const { whatsapp_number, password } = req.body;

  if (!whatsapp_number || !password) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const result = await pool.query("SELECT * FROM users WHERE whatsapp_number=$1", [whatsapp_number]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = password === user.password;
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    // ✅ Remove manual exp, let JWT handle expiry with expiresIn
    const token = jwt.sign(
      {
        aud: "authenticated",
        sub: user.id,
        fullname: user.fullname,
        username: user.username,
        role: user.role || "authenticated",
      },
      JWT_SECRET,
      { expiresIn: "7d" } // Expire in 7 days
    );

    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// GET CURRENT USER (/me)
// -----------------------------
app.get("/me", authMiddleware, async (req, res) => {
  try {
    // TEMPORARY: bypass RLS for testing by using a regular query
    const result = await pool.query(
      `SELECT id, fullname, username, whatsapp_number, gender, country, created_at, role, wallet_balance, engagement_points, pin_code
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: "User not found" });

    const user = result.rows[0];
    const isDefaultPin = user.pin_code === '1616';
    
    // Create a safe copy of the user object without the pin_code
    const { pin_code, ...safeUser } = user; // Exclude pin_code from response

    res.json({ ...safeUser, is_default_pin: isDefaultPin });
  } catch (err) {
    console.error("ME error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});


// -----------------------------
// UPDATE USERNAME
// -----------------------------
app.put("/update-username", authMiddleware, async (req, res) => {
  const { username } = req.body;
  const userId = req.user.id;

  if (!username) {
    return res.status(400).json({ error: "Username is required." });
  }

  // Basic username validation (e.g., alphanumeric, length)
  if (!/^[a-zA-Z0-9_]{3,15}$/.test(username)) {
    return res.status(400).json({ error: "Username must be 3-15 characters long and can only contain letters, numbers, and underscores." });
  }

  try {
    // Check if username is already taken by another user
    const existingUser = await pool.query("SELECT id FROM users WHERE username = $1 AND id != $2", [username, userId]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: "This username is already taken." });
    }

    const result = await pool.query(
      "UPDATE users SET username = $1 WHERE id = $2 RETURNING id, fullname, username",
      [username, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("Update username error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// UPDATE USER PROFILE (/update-profile)
// -----------------------------
app.put("/update-profile", authMiddleware, async (req, res) => {
  const { fullname, gender, country } = req.body;
  if (!fullname && !whatsapp_number && !gender && !country) {
    return res.status(400).json({ error: "Provide at least one field to update." });
  }

  try {
    const updates = [];
    const values = [];
    let index = 1;

    if (fullname) {
      updates.push(`fullname = $${index++}`);
      values.push(fullname);
    }

    if (gender) {
      updates.push(`gender = $${index++}`);
      values.push(gender);
    }
    if (country) {
      updates.push(`country = $${index++}`);
      values.push(country);
    }

    values.push(req.user.id);

    const result = await pool.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id=$${index} RETURNING id, fullname, whatsapp_number, gender, country, is_verified`,
      values
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Update profile error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});


// -----------------------------
// VERIFY CREDENTIALS
// -----------------------------
app.post("/verify-credentials", async (req, res) => {
  const { fullname, whatsapp_number, secret_answer } = req.body;

  if (!fullname || !whatsapp_number || !secret_answer) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    const result = await pool.query(
      "SELECT id, fullname, secret_answer FROM users WHERE whatsapp_number=$1",
      [whatsapp_number]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Compare fullname (case-insensitive) and secret_answer (case-insensitive)
    if (
      user.fullname.toLowerCase() !== fullname.toLowerCase() ||
      user.secret_answer.toLowerCase() !== secret_answer.toLowerCase()
    ) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // ✅ Verified
    res.json({ success: true, whatsapp_number });
  } catch (err) {
    console.error("Verify credentials error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});


// -----------------------------
// RESET PASSWORD
// -----------------------------
app.post("/reset-password", async (req, res) => {
  const { whatsapp_number, new_password } = req.body;

  if (!whatsapp_number || !new_password) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // Validate password
  const passwordRegex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/;
  if (!passwordRegex.test(new_password)) {
    return res.status(400).json({
      error: "Password must be at least 8 characters and include letters and numbers",
    });
  }

  try {
    const hashed = new_password;

    const result = await pool.query(
      "UPDATE users SET password=$1 WHERE whatsapp_number=$2 RETURNING id, fullname, whatsapp_number",
      [hashed, whatsapp_number]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// CHECK VERIFICATION STATUS
// -----------------------------
app.post("/auth/check-verification", async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: "WhatsApp number required" });
  }

  try {
    const result = await pool.query(
      "SELECT is_verified FROM users WHERE whatsapp_number=$1",
      [phone]
    );

    if (result.rows.length === 0) {
      return res.json({ verified: false });
    }

    res.json({ verified: result.rows[0].is_verified });
  } catch (err) {
    console.error("Check verification error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// ADMIN → VERIFY USER
// -----------------------------
app.put("/admin/verify-user", async (req, res) => {
  const { whatsapp_number } = req.body;
  if (!whatsapp_number) {
    return res.status(400).json({ error: "WhatsApp number required" });
  }

  try {
    const result = await pool.query(
      "UPDATE users SET is_verified=true WHERE whatsapp_number=$1 RETURNING id, fullname, whatsapp_number, is_verified",
      [whatsapp_number]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("Admin verify user error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// ADMIN → UPDATE USER (role, verification, wallet)
// -----------------------------
app.put("/admin/users", authMiddleware, async (req, res) => {
  const { id, role, is_verified, wallet_balance } = req.body;

  if (!id) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    // ✅ Ensure the requester is an admin
    const resultAdmin = await pool.query("SELECT role FROM users WHERE id=$1", [req.user.id]);
    if (resultAdmin.rows.length === 0 || resultAdmin.rows[0].role !== "admin") {
      return res.status(403).json({ error: "Access denied. Admins only." });
    }

    // Build dynamic update query
    const fields = [];
    const values = [];
    let index = 1;

    if (role) {
      fields.push(`role=$${index++}`);
      values.push(role);
    }

    if (typeof is_verified === "boolean") {
      fields.push(`is_verified=$${index++}`);
      values.push(is_verified);
    }

    if (wallet_balance !== undefined) {
      fields.push(`wallet_balance=$${index++}`);
      values.push(wallet_balance);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: "No fields provided for update" });
    }

    values.push(id);
    const query = `UPDATE users SET ${fields.join(", ")} WHERE id=$${index} RETURNING id, fullname, role, is_verified, wallet_balance`;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Admin update user error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});


// -----------------------------
// ADMIN → UPDATE USER BALANCE
// -----------------------------
// -----------------------------
// ADMIN → UPDATE USER BALANCE
// -----------------------------
app.put("/admin/update-balance", authMiddleware, async (req, res) => {
  const { whatsapp_number, new_balance } = req.body;
  const client = await pool.connect();

  if (!whatsapp_number || new_balance === undefined) {
    return res.status(400).json({ error: "WhatsApp number and new balance are required" });
  }

  try {
    // ✅ Check if requester is admin
    const resultAdmin = await client.query(
      "SELECT role FROM users WHERE id=$1",
      [req.user.id]
    );
    if (resultAdmin.rows.length === 0 || resultAdmin.rows[0].role !== "admin") {
      return res.status(403).json({ error: "Access denied. Admins only." });
    }

    // ✅ Update target user's balance
       await client.query("BEGIN");

    // Get current user data to calculate the difference
    const userRes = await client.query("SELECT id, wallet_balance FROM users WHERE whatsapp_number=$1 FOR UPDATE", [whatsapp_number]);
    
    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "User not found" });
    }

    const targetUser = userRes.rows[0];
    const oldBalance = parseFloat(targetUser.wallet_balance || 0);
    const updatedBalance = parseFloat(new_balance);
    const diff = updatedBalance - oldBalance;

    // Only record a transaction if there is a change
    if (diff !== 0) {
      const type = diff > 0 ? 'credit' : 'debit';
      const amount = Math.abs(diff);

      await client.query(
        `INSERT INTO wallet_transactions (user_id, type, amount, description, status)
         VALUES ($1, $2, $3, $4, 'completed')`,
        [targetUser.id, type, amount, `Admin Balance Adjustment (Manual)`]
      );
    }

    const result = await client.query(
      "UPDATE users SET wallet_balance=$1 WHERE id=$2 RETURNING id, fullname, whatsapp_number, wallet_balance",
      [updatedBalance, targetUser.id]
    );

    await client.query("COMMIT");

    res.json({ success: true, 
      message: "Wallet balance updated successfully",
      user: result.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Admin update balance error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  } finally {
    client.release();
  }
});

// -----------------------------
// CREATE BUS BOOKING (Deduct from wallet)
// -----------------------------
/**
 * POST /bus/hold
 * Temporarily hold seats for 3 minutes during checkout
 */
app.post("/bus/hold", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { bus_id, seats, travel_date } = req.body;
    const userId = req.user.id;
    const travelDateStr = new Date(travel_date).toISOString().split("T")[0];

    await client.query("BEGIN");

    // 1. Clean up expired holds for these specific seats first
    await client.query(
      `DELETE FROM bus_reservations 
       WHERE bus_id = $1 AND travel_date = $2 AND seat_number = ANY($3) 
       AND status = 'holding' AND hold_expires_at < NOW()`,
      [bus_id, travelDateStr, seats]
    );

    // 2. Check if seats are taken (pending/completed) or held by someone else
    const conflictCheck = await client.query(
      `SELECT seat_number FROM bus_reservations 
       WHERE bus_id = $1 AND travel_date = $2 AND seat_number = ANY($3) 
       AND (status IN ('pending', 'confirmed') OR (status = 'holding' AND user_id != $4))`,
      [bus_id, travelDateStr, seats, userId]
    );

    if (conflictCheck.rows.length > 0) {
      const taken = conflictCheck.rows.map(r => r.seat_number).join(", ");
      throw new Error(`Seats ${taken} are no longer available.`);
    }

    // 3. Upsert the hold (Update if user already holds it, insert otherwise)
    for (const seat of seats) {
      await client.query(
        `INSERT INTO bus_reservations (bus_id, user_id, seat_number, travel_date, status, hold_expires_at)
         VALUES ($1, $2, $3, $4, 'holding', NOW() + INTERVAL '3 minutes')
         ON CONFLICT (bus_id, travel_date, seat_number) 
         DO UPDATE SET status = 'holding', user_id = $2, hold_expires_at = NOW() + INTERVAL '3 minutes'`,
        [bus_id, userId, seat, travelDateStr]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, message: "Seats held for 3 minutes" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[BUS HOLD] Error:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post("/bus/bookings", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { bus_id, seats, travel_date, total_amount } = req.body;
    const userId = req.user.id;

    console.log(`[BUS BOOKING] New request from user: ${userId}`);
    console.log(`[BUS BOOKING] Payload: bus_id=${bus_id}, seats=${JSON.stringify(seats)}, travel_date=${travel_date}, total=${total_amount}`);

    if (!bus_id || !seats || !Array.isArray(seats) || seats.length === 0 || !travel_date || !total_amount) {
      console.warn("[BUS BOOKING] Validation failed: Missing or invalid fields");
      return res.status(400).json({ error: "Missing or invalid booking details (check seats array and travel date)." });
    }

    const total = parseFloat(total_amount);

    await client.query("BEGIN");

    // 0. Check if any of these seats were taken while the user was on the checkout screen
    let travelDateStr;
    try {
      travelDateStr = new Date(travel_date).toISOString().split("T")[0];
    } catch (e) {
      console.error("[BUS BOOKING] Invalid date format provided:", travel_date);
      throw new Error("Invalid travel date format. Please use YYYY-MM-DD.");
    }

    // 0. Check if any of these seats were taken by someone else 
    // (Includes active holds by other people)
    const existingCheck = await client.query(
      `SELECT seat_number FROM bus_reservations 
       WHERE bus_id = $1 AND travel_date = $2 AND seat_number = ANY($3) 
       AND (status IN ('pending', 'confirmed') OR (status = 'holding' AND hold_expires_at > NOW() AND user_id != $4))`,
      [bus_id, travelDateStr, seats, userId]
    );

    if (existingCheck.rows.length > 0) {
      const takenSeats = existingCheck.rows.map(r => r.seat_number).join(', ');
      throw new Error(`The following seats were just booked by someone else: ${takenSeats}`);
    }

    // 1. Check and lock user row to prevent race conditions during balance update
    const userRes = await client.query("SELECT id, wallet_balance FROM users WHERE id=$1 FOR UPDATE", [userId]);
    if (userRes.rows.length === 0) {
      console.error(`[BUS BOOKING] User ${userId} not found in database`);
      throw new Error("User not found");
    }

    console.log(`[BUS BOOKING] Verified user ${userId} exists in 'users' table.`);

    const balance = parseFloat(userRes.rows[0].wallet_balance);
    if (balance < total) {
      console.warn(`[BUS BOOKING] Insufficient balance. User has ${balance}, needs ${total}`);
      throw new Error("Insufficient wallet balance");
    }

    console.log(`[BUS BOOKING] User balance verified: ${balance}. Deducting ${total}...`);

    // 2. Deduct from wallet
    await client.query("UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2", [total, userId]);

    // 3. Record the transaction
    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description, status)
       VALUES ($1, 'debit', $2, $3, 'completed')`,
      [userId, total, `Bus Booking Payment: ${seats.length} seats for Bus ID ${bus_id}`]
    );

    // 4. Record the reservations
    console.log(`[BUS BOOKING] Step 4: Initializing ${seats.length} reservations for Bus ${bus_id} as 'pending'...`);
    for (const seatNumber of seats) {
      try {
        console.log(`[BUS BOOKING] Processing seat ${seatNumber}. Status: pending`);
        
        // We use ON CONFLICT to convert our existing 'holding' status into 'pending'
        // We set hold_expires_at to NULL because the hold is now a confirmed booking.
        await client.query(
          `INSERT INTO bus_reservations (bus_id, user_id, seat_number, travel_date, status, hold_expires_at, ticket_number)
           VALUES ($1, $2, $3, $4, 'pending', NULL, NULL)
           ON CONFLICT (bus_id, travel_date, seat_number) 
           DO UPDATE SET status = 'pending', hold_expires_at = NULL, user_id = $2, ticket_number = NULL`,
          [bus_id, userId, seatNumber, travelDateStr]
        );

        console.log(`[BUS BOOKING] Seat ${seatNumber} successfully initialized as pending.`);
      } catch (insertErr) {
        console.error(`[BUS BOOKING] Reservation insert failed for seat ${seatNumber}:`, insertErr.message);
        if (insertErr.message.includes("foreign key constraint")) {
           console.error("[BUS BOOKING] CONSTRAINT HINT: The 'bus_reservations' table likely references 'auth.users' instead of 'public.users'. Run the SQL fix in your Supabase editor.");
        }
        throw insertErr; // Re-throw to trigger rollback
      }
    }

    await client.query("COMMIT");
    console.log("[BUS BOOKING] Transaction committed successfully!");
    res.json({ success: true, message: "Booking confirmed and payment processed", booked_seats: seats });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Bus booking error:", err);
    res.status(500).json({ error: err.message || "Server error during booking" });
  } finally {
    client.release();
  }
});

/**
 * GET /bus/tickets
 * Fetch reservations for the logged-in user
 */
app.get("/bus/tickets", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, bus_id, seat_number, travel_date, status, created_at, ticket_number
       FROM bus_reservations
       WHERE user_id = $1
       ORDER BY travel_date DESC, created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Get bus tickets error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

/**
 * PUT /admin/bus/reservations/:id
 * Admin endpoint to update reservation status and generate Ticket IDs
 */
app.put("/api/admin/bus/reservations/:id", authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  let { status } = req.body;

  console.log(`[ADMIN BUS] Updating reservation ${id} status to: ${status}`);

  try {
    const result = await pool.query(
      "UPDATE bus_reservations SET status = $1, hold_expires_at = CASE WHEN $1 = 'confirmed' THEN NULL ELSE hold_expires_at END WHERE id = $2 RETURNING *",
      [status, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Reservation not found" });

    console.log(`[ADMIN BUS] Status updated for ${id}. Database trigger will handle ticket generation if status is 'confirmed'.`);
    return res.json(result.rows[0]);
  } catch (err) {
    console.error("[ADMIN BUS] Error updating reservation:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// CREATE ORDER
// -----------------------------
app.post("/orders", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    console.log("DEBUG: Received order payload:", JSON.stringify(req.body, null, 2));
    const { items, subtotal, service_fee, total_amount, payment_method } = req.body;

    // Validate input
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "No items in order" });
    }

    if (!subtotal || !total_amount || !payment_method) {
      return res.status(400).json({ error: "Missing order details" });
    }

    // Get user wallet
    const userRes = await pool.query("SELECT wallet_balance FROM users WHERE id=$1", [req.user.id]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const wallet_balance = parseFloat(userRes.rows[0].wallet_balance);
    const total = parseFloat(total_amount);

    // Check balance
    if (wallet_balance < total) {
      return res.status(400).json({ error: "Insufficient wallet balance" });
    }

    // Start transaction
    await client.query("BEGIN");

    // Deduct from wallet
    await client.query("UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2", [total, req.user.id]);

    // Record the transaction
    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description, status)
       VALUES ($1, 'debit', $2, $3, 'completed')`,
      [req.user.id, total, 'Order Payment']
    );

    // Insert into orders
    const orderRes = await client.query(
      `INSERT INTO orders (user_id, subtotal, service_fee, total_amount, payment_method)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [req.user.id, subtotal, service_fee, total_amount, payment_method]
    );

    const orderId = orderRes.rows[0].id;

    // Insert order items
    for (const item of items) {
      console.log("DEBUG: Inserting item:", item);
      await client.query(
        `INSERT INTO order_items (order_id, stock_id, quantity, price)
         VALUES ($1, $2, $3, $4)`,
        [orderId, item.stock_id, item.quantity, item.price]
      );
    }

    // Commit transaction
    await client.query("COMMIT");

    res.json({ success: true, order_id: orderId, message: "Order created successfully" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("DEBUG: Create order error details:", err);
    console.error("Create order error:", err);
    res.status(500).json({ error: "Connection timed out, retry again", details: err.message });
  } finally {
    client.release();
  }
});

// -----------------------------
// GET USER ORDERS
// -----------------------------
app.get("/orders", authMiddleware, async (req, res) => {
  console.log(`[GET /orders] Fetching orders for user: ${req.user.id}`);
  try {
    const ordersResult = await pool.query(
      `SELECT
          o.id, o.subtotal, o.service_fee, o.total_amount, o.created_at,
          COALESCE(
            (
              SELECT json_agg(
                json_build_object(
                  'id', COALESCE(i.id::text, gen_random_uuid()::text),
                  'quantity', i.quantity,
                  'price', i.price,
                  'stock_id', COALESCE(m.id::text, ''),
                  'medicine_name', COALESCE(m.name, 'Unknown'),
                  'medicine_image_url', COALESCE(m.image, '')
                )
              )
              FROM order_items i
              LEFT JOIN stock m ON i.stock_id = m.id
              WHERE i.order_id = o.id
            ),
            '[]'::json
          ) AS items
        FROM orders o
        WHERE o.user_id = $1
        ORDER BY o.created_at DESC`,
      [req.user.id]
    );

    res.json(ordersResult.rows);
  } catch (err) {
    console.error("Get orders error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// GET SINGLE ORDER
// -----------------------------
app.get("/orders/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  console.log(`[GET /orders/:id] Fetching order ${id} for user: ${req.user.id}`);
  try {
    const orderResult = await pool.query(
      `SELECT
          o.id, o.subtotal, o.service_fee, o.total_amount, o.created_at,
          -- Get the pharmacy of the first item as the main pharmacy for the order
          (
            SELECT json_build_object('name', p.name)
            FROM order_items i
            JOIN stock m ON i.stock_id = m.id
            JOIN pharmacy_applications p ON m.pharmacy_id = p.id
            WHERE i.order_id = o.id
            ORDER BY i.id
            LIMIT 1
          ) as pharmacy,
          -- Get all items, each with its own pharmacy
          COALESCE(
            (SELECT json_agg(
              json_build_object(
                'id', i.id,
                'quantity', i.quantity,
                'price', i.price,
                'product_name', m.name,
                'product_image_url', m.image,
                'pharmacy', json_build_object('name', p.name)
              )
            )
            FROM order_items i
            LEFT JOIN stock m ON i.stock_id = m.id
            LEFT JOIN pharmacy_applications p ON m.pharmacy_id = p.id
            WHERE i.order_id = o.id),
            '[]'::json
          ) AS items
        FROM orders o
        WHERE o.id = $1 AND o.user_id = $2`,
      [id, req.user.id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: "Order not found or access denied" });
    }

    res.json(orderResult.rows[0]);
  } catch (err) {
    console.error("Get single order error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// ADMIN → GET ALL ORDERS
// -----------------------------
app.get("/api/admin/orders", authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, u.fullname as user_fullname
       FROM orders o
       JOIN users u ON o.user_id = u.id
       ORDER BY o.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Admin get all orders error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// ADMIN → GET SINGLE ORDER
// -----------------------------
app.get("/api/admin/orders/:id", authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  try {
    const orderResult = await pool.query(
      `SELECT
          o.id, o.subtotal, o.service_fee, o.total_amount, o.created_at, o.payment_method,
          json_build_object('fullname', u.fullname) as customer,
          COALESCE(
            (SELECT json_agg(
              json_build_object(
                'id', i.id,
                'name', p.name,
                'image', p.image,
                'quantity', i.quantity,
                'price', i.price
              )
            )
            FROM order_items i
            LEFT JOIN stock p ON i.stock_id = p.id
            WHERE i.order_id = o.id),
            '[]'::json
          ) as items
        FROM orders o
        JOIN users u ON o.user_id = u.id
        WHERE o.id = $1`,
      [id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: "Order not found" });
    }

    res.json(orderResult.rows[0]);
  } catch (err) {
    console.error("Admin get single order error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// ADMIN → UPDATE ORDER STATUS
// -----------------------------
app.put("/api/admin/orders/:id", authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: "Status is required" });
  }

  try {
    const result = await pool.query(
      "UPDATE orders SET status = $1 WHERE id = $2 RETURNING *",
      [status, id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "Order not found" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Admin update order status error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// DEDUCT FOR VIEW
// -----------------------------
app.post("/wallet/deduct-for-view", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { amount, reason, pin } = req.body;
    const userId = req.user.id;

    if (!amount || typeof amount !== 'number' || amount <= 0 || !pin) {
      return res.status(400).json({ error: "Invalid amount or PIN specified." });
    }

    await client.query("BEGIN");

    // 1. Get user and lock the row for update to prevent race conditions
    const userRes = await client.query("SELECT id, wallet_balance, pin_code FROM users WHERE id = $1 FOR UPDATE", [userId]);

    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "User account no longer exists. Please log out and log in again." });
    }

    const user = userRes.rows[0];

    // 2. Check PIN
    if (user.pin !== pin) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Invalid PIN." });
    }

    // 3. Check for sufficient balance
    if (user.wallet_balance < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient wallet balance." });
    }

    // 4. Deduct amount from wallet
    const updateRes = await client.query("UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2 RETURNING wallet_balance", [amount, userId]);

    // 5. Record the transaction
    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description, status)
       VALUES ($1, 'debit', $2, $3, 'completed')`,
      [userId, amount, reason || 'View Access Fee']
    );

    await client.query("COMMIT");

    res.json({ success: true, new_balance: updateRes.rows[0].wallet_balance });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Deduct for view error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  } finally {
    client.release();
  }
});

// -----------------------------
// ✅ DEDUCT FROM WALLET (PIN should be verified before calling this)
// -----------------------------
app.post("/wallet/deduct", authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { amount, reason } = req.body;
    const userId = req.user.id;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: "A valid amount is required." });
    }

    await client.query("BEGIN");

    // 1. Get user and lock the row for update
    const userRes = await client.query("SELECT id, wallet_balance FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "User account no longer exists. Please log out and log in again." });
    }

    // 2. Check for sufficient balance
    if (userRes.rows[0].wallet_balance < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient wallet balance." });
    }

    // 3. Deduct amount from wallet
    const updateRes = await client.query("UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2 RETURNING wallet_balance", [amount, userId]);

    // 4. Record the transaction
    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, amount, description, status)
       VALUES ($1, 'debit', $2, $3, 'completed')`,
      [userId, amount, reason || 'Wallet Deduction']
    );

    await client.query("COMMIT");
    res.json({ success: true, new_balance: updateRes.rows[0].wallet_balance });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Deduct error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  } finally {
    client.release();
  }
});

// -----------------------------
// GET WALLET TRANSACTIONS
// -----------------------------
app.get("/wallet/transactions", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, type, amount, description, status, created_at FROM wallet_transactions WHERE user_id = $1 ORDER BY created_at DESC",
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Get transactions error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// ✅ CHECK IF USER HAS PIN
app.get("/has-pin", authMiddleware, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query("SELECT pin_code FROM users WHERE id = $1", [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = result.rows[0];
    res.json({ hasPin: !!user.pin_code }); // <-- FIXED
  } catch (err) {
    console.error("Has PIN error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// ✅ SET or UPDATE PIN
app.put("/set-pin", authMiddleware, async (req, res) => {
  const { pin_code } = req.body; // <-- FIXED
  const userId = req.user.id;

  if (!pin_code || !/^\d{4}$/.test(pin_code)) {
    return res.status(400).json({ error: "A 4-digit PIN is required." });
  }

  try {
    const result = await pool.query(
      "UPDATE users SET pin_code = $1 WHERE id = $2 RETURNING id",
      [pin_code, userId] // <-- FIXED
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    res.status(200).json({ success: true, message: "PIN updated successfully." });
  } catch (err) {
    console.error("Set PIN error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// ✅ VERIFY PIN
app.post("/verify-pin", authMiddleware, async (req, res) => {
  const { pin_code } = req.body; // <-- FIXED
  const userId = req.user.id;

  if (!pin_code) {
    return res.status(400).json({ error: "PIN is required." });
  }

  try {
    const result = await pool.query("SELECT pin_code FROM users WHERE id = $1", [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    const user = result.rows[0];
    if (user.pin_code !== pin_code) { // <-- FIXED
      return res.status(401).json({ error: "Incorrect PIN." });
    }

    res.json({ success: true, message: "PIN verified successfully." });
  } catch (err) {
    console.error("Verify PIN error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});


// -----------------------------
// FILE UPLOADS (Images & Videos)
// -----------------------------
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit for videos
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp|mp4|mov|avi|mkv|webm/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Error: File upload only supports images and videos!"));
  },
});

app.use("/uploads", express.static("uploads"));

app.post("/upload", authMiddleware, adminOnly, upload.single("file"), (req, res) => {
  if (!req.file) {
    console.log("[Upload] Request received but no file was processed by Multer");
    return res.status(400).json({ error: "No file uploaded or invalid file type" });
  }
  const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
  console.log("[Upload] Success:", fileUrl);
  res.json({ url: fileUrl });
});

// Error handler for Multer rejections
app.use("/upload", (err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message.includes("supports images and videos")) {
    console.error("[Upload] Multer Error:", err.message);
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// -----------------------------
// STORIES CRUD
// -----------------------------
app.get("/stories", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM stories ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("Get stories error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

app.post("/stories", authMiddleware, adminOnly, async (req, res) => {
  const { name, avatar, images, tag, website, show_tag, show_website } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO stories (name, avatar, images, tag, website, show_tag, show_website) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [name, avatar, JSON.stringify(images), tag, website, show_tag ?? true, show_website ?? true]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Create story error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

app.put("/stories/:id", authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { name, avatar, images, tag, website, show_tag, show_website } = req.body;
  try {
    const result = await pool.query(
      "UPDATE stories SET name = $1, avatar = $2, images = $3, tag = $4, website = $5, show_tag = $6, show_website = $7 WHERE id = $8 RETURNING *",
      [name, avatar, JSON.stringify(images), tag, website, show_tag ?? true, show_website ?? true, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Story not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Update story error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

app.delete("/stories/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM stories WHERE id = $1 RETURNING id", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Story not found" });
    res.json({ message: "Story deleted successfully" });
  } catch (err) {
    console.error("Delete story error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// INTERACTIONS (Tracking)
// -----------------------------

app.post("/interactions/story-view", authMiddleware, async (req, res) => {
  console.log("[STORY VIEW] Payload:", req.body);
  const { story_id, story_name, image_index } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Insert view (ignore if exists due to UNIQUE constraint)
    const result = await client.query(
      "INSERT INTO story_views (user_id, user_name, story_id, story_name, image_index) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id",
      [req.user.id, req.user.fullname, story_id, story_name, image_index]
    );
    console.log(`[STORY VIEW] DB Result for story_id ${story_id}: ${result.rowCount > 0 ? 'Inserted' : 'Conflict (Already viewed, ignored)'}`);
    // EP is now updated automatically via SQL Trigger: trg_update_ep_on_story_view
    await client.query("COMMIT");
    const epRes = await client.query("SELECT engagement_points FROM users WHERE id = $1", [req.user.id]);
    res.json({ success: true, engagement_points: epRes.rows[0].engagement_points });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[STORY VIEW] Error for story_id ${story_id}:`, err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  } finally { client.release(); }
});

app.post("/interactions/post-like", authMiddleware, async (req, res) => {
  console.log("[POST LIKE] Payload:", req.body);
  const { post_id, post_title } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "INSERT INTO post_likes (user_id, user_name, post_id, post_title) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id",
      [req.user.id, req.user.fullname, post_id, post_title]
    );
    // Only increment EP and Post likes if this is a new like
    if (result.rows.length > 0) {
      console.log(`[POST LIKE] Successfully inserted like for post_id ${post_id}`);
      // EP is now updated automatically via SQL Trigger: trg_update_ep_on_post_like
      // We still use post_id here for the counter because it's the primary key of the 'posts' table
      if (post_id) {
        await client.query("UPDATE posts SET likes = likes + 1 WHERE id = $1", [post_id]);
      }
    }
    await client.query("COMMIT");
    const epRes = await client.query("SELECT engagement_points FROM users WHERE id = $1", [req.user.id]);
    res.json({ success: true, engagement_points: epRes.rows[0].engagement_points });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[POST LIKE] Error for post_id ${post_id}:`, err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  } finally { client.release(); }
});

app.post("/interactions/post-view", authMiddleware, async (req, res) => {
  console.log("[POST VIEW] Payload:", req.body);
  const { post_id, post_title, image_index } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "INSERT INTO post_views (user_id, user_name, post_id, post_title, image_index) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id",
      [req.user.id, req.user.fullname, post_id, post_title, image_index]
    );
    console.log(`[POST VIEW] DB Result for post_id ${post_id}: ${result.rowCount > 0 ? 'Inserted' : 'Conflict (Already viewed, ignored)'}`);
    // EP is now updated automatically via SQL Trigger: trg_update_ep_on_post_view
    await client.query("COMMIT");
    const epRes = await client.query("SELECT engagement_points FROM users WHERE id = $1", [req.user.id]);
    res.json({ success: true, engagement_points: epRes.rows[0].engagement_points });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[POST VIEW] Error for post_id ${post_id}:`, err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  } finally { client.release(); }
});

// -----------------------------
// FETCH USER INTERACTIONS
// -----------------------------
app.get("/interactions/me", authMiddleware, async (req, res) => {
  try {
    const likesRes = await pool.query(
      "SELECT post_id FROM post_likes WHERE user_id = $1",
      [req.user.id]
    );
    
    const postViewsRes = await pool.query(
      "SELECT post_id, image_index FROM post_views WHERE user_id = $1",
      [req.user.id]
    );

    const storyViewsRes = await pool.query(
      "SELECT story_id, image_index FROM story_views WHERE user_id = $1",
      [req.user.id]
    );

    res.json({
      likedPostIds: likesRes.rows.map(r => r.post_id),
      viewedPosts: postViewsRes.rows.map(r => ({
        post_id: r.post_id,
        image_index: r.image_index
      })),
      viewedStories: storyViewsRes.rows.map(r => ({
        story_id: r.story_id,
        image_index: r.image_index
      }))
    });
  } catch (err) {
    console.error("Fetch user interactions error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// ADMIN INTERACTION STATS
// -----------------------------

app.get("/api/admin/stats/story/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sv.user_id, sv.user_name as fullname, u.whatsapp_number, sv.story_name, sv.image_index, sv.created_at 
       FROM story_views sv 
       LEFT JOIN users u ON sv.user_id = u.id
       WHERE sv.story_id = $1 
       ORDER BY sv.created_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Stats error" }); }
});

app.get("/api/admin/stats/post/:id/likes", authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pl.user_id, pl.user_name as fullname, u.whatsapp_number, pl.post_title, pl.created_at 
       FROM post_likes pl 
       LEFT JOIN users u ON pl.user_id = u.id
       WHERE pl.post_id = $1 
       ORDER BY pl.created_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Stats error" }); }
});

app.get("/api/admin/stats/post/:id/views", authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pv.user_id, pv.user_name as fullname, u.whatsapp_number, pv.post_title, pv.image_index, pv.created_at 
       FROM post_views pv 
       LEFT JOIN users u ON pv.user_id = u.id
       WHERE pv.post_id = $1 
       ORDER BY pv.created_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Stats error" }); }
});

app.get("/api/admin/leaderboard", authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, fullname, whatsapp_number, country, engagement_points FROM users ORDER BY engagement_points DESC LIMIT 50"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Leaderboard error" });
  }
});

// -----------------------------
// POSTS CRUD
// -----------------------------
app.get("/posts", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM posts ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("Get posts error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

app.post("/posts", authMiddleware, adminOnly, async (req, res) => {
  const { title, tag, avatar, images, caption, website, whatsapp, instagram, twitter, show_website, show_whatsapp, show_instagram, show_twitter } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO posts (title, tag, avatar, images, caption, website, whatsapp, instagram, twitter, show_website, show_whatsapp, show_instagram, show_twitter) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *",
      [title, tag, avatar, JSON.stringify(images), caption, website, whatsapp, instagram, twitter, show_website ?? true, show_whatsapp ?? true, show_instagram ?? true, show_twitter ?? true]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Create post error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

app.put("/posts/:id", authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { title, tag, avatar, images, caption, website, whatsapp, instagram, twitter, show_website, show_whatsapp, show_instagram, show_twitter } = req.body;
  try {
    const result = await pool.query(
      "UPDATE posts SET title = $1, tag = $2, avatar = $3, images = $4, caption = $5, website = $6, whatsapp = $7, instagram = $8, twitter = $9, show_website = $10, show_whatsapp = $11, show_instagram = $12, show_twitter = $13 WHERE id = $14 RETURNING *",
      [title, tag, avatar, JSON.stringify(images), caption, website, whatsapp, instagram, twitter, show_website ?? true, show_whatsapp ?? true, show_instagram ?? true, show_twitter ?? true, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Post not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Update post error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

app.delete("/posts/:id", authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM posts WHERE id = $1 RETURNING id", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Post not found" });
    res.json({ message: "Post deleted successfully" });
  } catch (err) {
    console.error("Delete post error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// REVIEWS
// -----------------------------
app.get("/reviews", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, user_id, name, rating, comment, admin_reply, created_at FROM reviews ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Get reviews error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

app.post("/reviews", authMiddleware, async (req, res) => {
  const { name, rating, comment } = req.body;

  if (!name || !rating || !comment) {
    return res.status(400).json({ error: "Name, rating, and comment are required" });
  }

  try {
    const result = await pool.query(
      "INSERT INTO reviews (user_id, name, rating, comment) VALUES ($1, $2, $3, $4) RETURNING id, user_id, name, rating, comment, created_at",
      [req.user.id, name, rating, comment]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Post review error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

app.put("/api/admin/reviews/:id/reply", authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { admin_reply } = req.body;

  console.log(`[ADMIN REPLY] PUT /admin/reviews/${id}/reply`);
  console.log(`[ADMIN REPLY] From: ${req.user.fullname} (${req.user.id})`);
  
  if (admin_reply === undefined) {
    return res.status(400).json({ error: "admin_reply field is required in request body" });
  }

  try {
    const result = await pool.query(
      "UPDATE reviews SET admin_reply = $1 WHERE id = $2 RETURNING *",
      [admin_reply, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Review not found" });
    console.log(`[ADMIN REPLY] Success for ID: ${id}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[ADMIN REPLY] DB ERROR:", err.message);
    res.status(500).json({ error: "Connection timed out, retry again", details: err.message });
  }
});

app.put("/reviews/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { name, rating, comment } = req.body;
  try {
    const result = await pool.query(
      "UPDATE reviews SET name = $1, rating = $2, comment = $3 WHERE id = $4 AND user_id = $5 RETURNING id, user_id, name, rating, comment, created_at",
      [name, rating, comment, id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Review not found or unauthorized" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Update review error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

app.delete("/api/admin/reviews/:id", authMiddleware, adminOnly, async (req, res) => {
  const { id } = req.params;
  console.log(`[ADMIN DELETE REVIEW] Request for ID: ${id} by User: ${req.user.id}`);
  
  try {
    const result = await pool.query("DELETE FROM reviews WHERE id = $1 RETURNING id", [id]);
    console.log(`[ADMIN DELETE REVIEW] DB result rowCount: ${result.rowCount}`);
    if (result.rows.length === 0) return res.status(404).json({ error: "Review not found" });
    res.json({ message: "Review deleted successfully" });
  } catch (err) {
    console.error("Admin delete review error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

app.delete("/reviews/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    let result;
    if (req.user.role === 'admin') {
      result = await pool.query("DELETE FROM reviews WHERE id = $1 RETURNING id", [id]);
    } else {
      result = await pool.query(
        "DELETE FROM reviews WHERE id = $1 AND user_id = $2 RETURNING id",
        [id, req.user.id]
      );
    }
    if (result.rows.length === 0) return res.status(404).json({ error: "Review not found or unauthorized" });
    res.json({ message: "Review deleted successfully" });
  } catch (err) {
    console.error("Delete review error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// -----------------------------
// ✅ ADMIN: OVERALL STATS
// -----------------------------
app.get("/api/admin/stats/overall", authMiddleware, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    // 1. Admin Revenue - Service Fees from Orders
    const adminServiceFeesRes = await client.query("SELECT SUM(service_fee) as total FROM orders");
    const serviceFees = parseFloat(adminServiceFeesRes.rows[0].total || 0);

    // 2. Admin Revenue - Login/Access Fees from wallet_transactions
    const adminAccessFeesRes = await client.query(
      "SELECT SUM(amount) as total FROM wallet_transactions WHERE description ILIKE '%View Access Fee%' OR description ILIKE '%Wallet Deduction%' OR description ILIKE '%Login Fee%' OR description ILIKE '%Access Fee%'"
    );
    const loginFees = parseFloat(adminAccessFeesRes.rows[0].total || 0);

    // 2b. Admin Revenue - Bus Booking Payments
    const adminBusFeesRes = await client.query(
      "SELECT SUM(amount) as total FROM wallet_transactions WHERE description ILIKE 'Bus Booking Payment%'"
    );
    const busFees = parseFloat(adminBusFeesRes.rows[0].total || 0);

    // 3. Approved Doctors + Total Revenue earned from paid bookings
    const doctorsRes = await client.query(`
      SELECT da.id, da.name, da.image, COALESCE(SUM(b.amount), 0) as revenue
      FROM doctor_applications da
      LEFT JOIN bookings b ON b.doctor_id = da.id AND (b.payment_status ILIKE 'paid' OR b.payment_status IS NULL)
      WHERE da.status = 'approved'
      GROUP BY da.id, da.name, da.image
    `);

    console.log("DEBUG: [Node Server] Overall Stats - Processed Doctor Revenue:", doctorsRes.rows);

    // 4. Approved Hospitals + Revenue
    const hospitalsRes = await client.query(`
      SELECT id, name, image, 0 as revenue
      FROM hospital_applications
      WHERE status = 'approved'
    `);

    // 5. Approved Insurances
    const insurancesRes = await client.query(`
      SELECT id, name, image, 0 as revenue
      FROM insurance_applications
      WHERE status = 'approved'
    `);

    // 6. Approved Pharmacies + Total Revenue earned from delivered orders
    const pharmaciesRes = await client.query(`
      SELECT pa.id, pa.name, pa.image, COALESCE(SUM(oi.price * oi.quantity), 0) as revenue
      FROM pharmacy_applications pa
      LEFT JOIN stock s ON s.pharmacy_id = pa.id
      LEFT JOIN order_items oi ON oi.stock_id = s.id AND oi.status = 'Delivered'
      WHERE pa.status = 'approved'
      GROUP BY pa.id, pa.name, pa.image
    `);

    res.json({
      doctors: doctorsRes.rows.map(r => ({ ...r, revenue: parseFloat(r.revenue) })),
      hospitals: hospitalsRes.rows.map(r => ({ ...r, revenue: parseFloat(r.revenue) })),
      insurances: insurancesRes.rows.map(r => ({ ...r, revenue: parseFloat(r.revenue) })),
      pharmacies: pharmaciesRes.rows.map(r => ({ ...r, revenue: parseFloat(r.revenue) })),
      admin: {
        serviceFees,
        loginFees,
        busFees,
        total: serviceFees + loginFees + busFees
      }
    });
  } catch (err) {
    console.error("Overall stats error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  } finally {
    client.release();
  }
});

// -----------------------------
// COMMENTS CRUD
// -----------------------------

// POST a new comment
app.post("/comments", authMiddleware, async (req, res) => {
  const { post_id, comment_text, user_username, parent_id } = req.body;
  const userId = req.user.id;
  // Priority: username sent in body (frontend state) -> username in token
  // Ensure req.user.username is available from JWT payload
  if (!req.user.username) console.warn(`[POST /comments] req.user.username is missing for user ${userId}`);
  const finalUsername = user_username || req.user.username;

  console.log(`[POST /comments] Attempt by user ${userId} (${finalUsername}) on post ${post_id}, parent_id: ${parent_id}`);

  if (!post_id || !comment_text || !finalUsername) {
    console.error(`[POST /comments] Validation failed. Missing fields: post_id=${post_id}, comment_text=${!!comment_text}, username=${finalUsername}`);
    return res.status(400).json({ error: "Post ID, comment text, and user username are required." });
  }

  try {
    const result = await pool.query(
      "INSERT INTO post_comments (post_id, user_id, user_username, comment_text, parent_id) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [post_id, userId, finalUsername, comment_text, parent_id || null]
    );
    const newComment = result.rows[0];

    // --- Notification Logic ---
    // 1. Notify for Reply
    if (parent_id) {
      const parentCommentRes = await pool.query("SELECT user_id FROM post_comments WHERE id = $1", [parent_id]);
      if (parentCommentRes.rows.length > 0) {
        const recipientId = parentCommentRes.rows[0].user_id;
        // Don't notify if replying to self
        if (recipientId !== userId) {
          await pool.query(
            "INSERT INTO notifications (user_id, type, source_user_id, comment_id, post_id) VALUES ($1, 'reply', $2, $3, $4)",
            [recipientId, userId, newComment.id, post_id]
          );
        }
      }
    }

    // 2. Notify for Mentions (Regex for @username)
    const mentions = comment_text.match(/@(\w+)/g);
    if (mentions) {
      const usernames = mentions.map(m => m.substring(1));
      const usersRes = await pool.query("SELECT id FROM users WHERE username = ANY($1)", [usernames]);
      for (const u of usersRes.rows) {
        if (u.id !== userId) {
          await pool.query(
            "INSERT INTO notifications (user_id, type, source_user_id, comment_id, post_id) VALUES ($1, 'mention', $2, $3, $4) ON CONFLICT DO NOTHING",
            [u.id, userId, newComment.id, post_id]
          );
        }
      }
    }

    res.status(201).json(newComment);
  } catch (err) {
    console.error("Create comment error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// UPDATE a comment
app.put("/comments/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { comment_text } = req.body;
  const userId = req.user.id;

  try {
    const result = await pool.query(
      "UPDATE post_comments SET comment_text = $1 WHERE id = $2 AND user_id = $3 RETURNING *",
      [comment_text, id, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Comment not found or unauthorized" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Update comment error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// DELETE a comment
app.delete("/comments/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    let result;
    if (userRole === "admin") {
      result = await pool.query("DELETE FROM post_comments WHERE id = $1 RETURNING id", [id]);
    } else {
      result = await pool.query(
        "DELETE FROM post_comments WHERE id = $1 AND user_id = $2 RETURNING id",
        [id, userId]
      );
    }
    if (result.rows.length === 0) return res.status(404).json({ error: "Comment not found or unauthorized" });
    res.json({ message: "Comment deleted successfully" });
  } catch (err) {
    console.error("Delete comment error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// GET comments for a specific post
app.get("/posts/:id/comments", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, post_id, user_id, user_username, comment_text, parent_id, created_at 
       FROM post_comments 
       WHERE post_id = $1 
       ORDER BY 
         (SELECT created_at FROM post_comments pc2 WHERE pc2.id = COALESCE(post_comments.parent_id, post_comments.id)) DESC, 
         created_at ASC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Get comments error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// --- NOTIFICATIONS ENDPOINTS ---

app.get("/notifications", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         n.id, n.user_id, n.type, n.source_user_id, n.comment_id, n.post_id, n.is_read, n.created_at,
         u.username as source_username,
         p.title as post_title,
         c.comment_text as comment_text_preview
       FROM notifications n
       JOIN users u ON n.source_user_id = u.id
       JOIN posts p ON n.post_id = p.id
       JOIN post_comments c ON n.comment_id = c.id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Fetch notifications error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

app.put("/notifications/mark-read", authMiddleware, async (req, res) => {
  const { notification_ids } = req.body;
  if (!notification_ids || !Array.isArray(notification_ids)) return res.status(400).json({ error: "Invalid IDs" });

  try {
    await pool.query(
      "UPDATE notifications SET is_read = true WHERE id = ANY($1) AND user_id = $2",
      [notification_ids, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Mark read error:", err);
    res.status(500).json({ error: "Connection timed out, retry again" });
  }
});

// Note: For a full CRUD, you might also want PUT and DELETE for comments,
// possibly with authorization checks (e.g., only the comment owner or an admin can edit/delete).
// This implementation focuses on the user's request for adding a comment icon and username check.



// Catch-all for 404 - Must be after all other routes
app.use((req, res, next) => {
  console.warn(`[404] Route not found: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: "Not Found" });
});


// -----------------------------
// GLOBAL ERROR HANDLER
// -----------------------------
app.use((err, req, res, next) => {
  console.error("Uncaught Server Error:", err.stack);
  res.status(500).json({ error: "Connection timed out, retry again" });
});

// -----------------------------
// SERVER
// -----------------------------

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
