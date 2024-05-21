const { Pool } = require('pg');

// Create a new pool instance using the connection string provided by Heroku
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Necessary if using SSL to connect to Heroku Postgres
  }
});

// Function to query the database
async function query(text, params) {
  const start = Date.now();
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    const duration = Date.now() - start;
    console.log('Executed query:', { text, duration, rows: res.rowCount });
    return res;
  } finally {
    client.release();
  }
}

module.exports = {
  query
};
