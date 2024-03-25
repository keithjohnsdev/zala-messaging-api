const app = require('./index.js')

// Start the server
const PORT = process.env.PORT || 4000; // Use the provided port or default to 3000
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});