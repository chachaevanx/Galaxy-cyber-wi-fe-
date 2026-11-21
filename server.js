const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-this-admin-token";
const FRONTEND = "https://chachaevanx.github.io";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", FRONTEND);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Testing data only: stored in memory and reset on restart.
const packages = [
  {id:1,name:"3 Hours",duration_minutes:180,single_price:10,two_device_price:20,active:1},
  {id:2,name:"6 Hours",duration_minutes:360,single_price:20,two_device_price:30,active:1},
  {id:3,name:"24 Hours (1 Day)",duration_minutes:1440,single_price:30,two_device_price:40,active:1},
  {id:4,name:"48 Hours (2 Days)",duration_minutes:2880,single_price:50,two_device_price:80,active:1},
  {id:5,name:"72 Hours (3 Days)",duration_minutes:4320,single_price:80,two_device_price:100,active:1},
  {id:6,name:"96 Hours (4 Days)",duration_minutes:5760,single_price:100,two_device_price:150,active:1},
  {id:7,name:"7 Days",duration_minutes:10080,single_price:150,two_device_price:200,active:1},
  {id:8,name:"1 Month",duration_minutes:43200,single_price:400,two_device_price:600,active:1}
];

const payments = [];
const subscriptions = [];

function adminOnly(req,res,next) {
  const token = (req.headers.authorization || "").replace("Bearer ","");
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({success:false,error:"Unauthorized"});
  }
  next();
}

app.get("/", (req,res) => {
  res.json({success:true,message:"Galex Cyber WiFi testing API"});
});

app.get("/api/health", (req,res) => {
  res.json({success:true,status:"ok",mode:"testing"});
});

app.get("/api/packages", (req,res) => {
  res.json({success:true,packages:packages.filter(p => p.active)});
});

// TEST ONLY: no real M-Pesa request is sent.
app.post("/api/payments/stkpush", (req,res) => {
  const {phone,package_id,device_limit} = req.body;
  const selected = packages.find(p => p.id === Number(package_id) && p.active);

  if (!phone || !selected || ![1,2].includes(Number(device_limit))) {
    return res.status(400).json({success:false,error:"Invalid payment details"});
  }

  const amount = Number(device_limit) === 1
    ? selected.single_price
    : selected.two_device_price;

  const checkout = "TEST-" + crypto.randomUUID();

  payments.push({
    checkout_request_id:checkout,
    phone,
    package_id:selected.id,
    amount,
    device_limit:Number(device_limit),
    status:"pending",
    created_at:new Date().toISOString()
  });

  res.json({
    success:true,
    testing:true,
    message:"Test request received. No money has been charged.",
    checkout_request_id:checkout,
    amount,
    status:"pending"
  });
});

app.get("/api/payment-status/:checkoutId", (req,res) => {
  const payment = payments.find(
    p => p.checkout_request_id === req.params.checkoutId
  );

  if (!payment) {
    return res.status(404).json({success:false,error:"Payment not found"});
  }

  res.json({success:true,status:payment.status,payment});
});

app.get("/api/admin/summary", adminOnly, (req,res) => {
  res.json({
    success:true,
    total_payments:payments.length,
    pending_payments:payments.filter(p => p.status === "pending").length,
    total_subscriptions:subscriptions.length
  });
});

app.get("/api/admin/subscriptions", adminOnly, (req,res) => {
  res.json({success:true,subscriptions});
});

app.get("/api/admin/payments", adminOnly, (req,res) => {
  res.json({success:true,payments});
});

app.listen(PORT, () => {
  console.log("Galex Cyber WiFi API running on port " + PORT);
});
      
