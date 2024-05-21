const express = require("express");
const db = require("./db");

const router = express.Router();

router.get("/messageStatus", (req, res) => {
    const status = {
        Status: "Message Routes Working",
    };

    res.send(status);
});


module.exports = router;