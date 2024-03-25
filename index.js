const express = require("express");

// Create a new Express application
const app = express();

// Define routes

// Example route to get all items from a table
// app.get("/items", async (req, res) => {
//   try {
//     // Query to select all items from a table
//     const result = await pool.query("SELECT * FROM your_table");
//     // Send the response with the retrieved items
//     res.json(result.rows);
//   } catch (error) {
//     // If an error occurs, send an error response
//     console.error("Error executing query", error);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

app.get("/status", (req, res) => {
    const status = {
       "Status": "Running"
    };
    
    res.send(status);
 });

 module.exports = app;
