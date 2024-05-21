const express = require("express");
const db = require("./db");

const router = express.Router();

router.get("/messageStatus", (req, res) => {
    const status = {
        Status: "Message Routes Working",
    };

    res.send(status);
});

router.post("/sendMessage", async (req, res) => {
    const {
        userId: senderUserId,
        userFullName: senderFullName,
        userEmail: senderEmail,
    } = req;
    const {
        recipientFullName,
        recipientUserId,
        conversationId,
        conversationTitle,
        content,
    } = req.body;
    console.log('---- recipient id:')
    console.log(recipientUserId)

    try {
        // Check if the sender exists in the users table
        let sender = await db.query(
            "SELECT * FROM users WHERE user_uuid = $1",
            [senderUserId]
        );

        if (sender.rowCount === 0) {
            // Insert the sender if they don't exist
            console.log("sender user doesnt exist, creating new user");
            await db.query(
                "INSERT INTO users (user_uuid, name, email, created_at) VALUES ($1, $2, $3, NOW())",
                [senderUserId, senderFullName, senderEmail]
            );
        } else if (!sender.rows[0].email) {
            // Update the sender if email is missing
            await db.query("UPDATE users SET email = $1 WHERE user_uuid = $2", [
                senderEmail,
                senderUserId,
            ]);
        }

        // Check if the recipient exists in the users table
        let recipient = await db.query(
            "SELECT * FROM users WHERE user_uuid = $1",
            [recipientUserId]
        );

        if (recipient.rowCount === 0) {
            // Insert the recipient if they don't exist
            console.log("recipient user doesnt exist, creating new user");
            await db.query(
                "INSERT INTO users (user_uuid, name, created_at) VALUES ($1, $2, NOW())",
                [recipientUserId, recipientFullName]
            );
        }

        let convoId = conversationId;

        // Check if the conversation exists if conversationId is not provided or null
        if (!convoId) {
            const conversation = await db.query(
                "SELECT * FROM conversations WHERE ((user1_uuid = $1 AND user2_uuid = $2) OR (user1_uuid = $2 AND user2_uuid = $1)) AND title = $3",
                [senderUserId, recipientUserId, conversationTitle]
            );

            if (conversation.rowCount === 0) {
                // Insert the conversation if it doesn't exist
                console.log("convo doesnt exist, creating new");
                const newConversation = await db.query(
                    "INSERT INTO conversations (user1_uuid, user2_uuid, title, latest_message, latest_message_sender, read, created_at, updated_at) VALUES ($1, $2, $3, $4, $1, $5, NOW(), NOW()) RETURNING conversation_id",
                    [senderUserId, recipientUserId, conversationTitle, content, false]
                );

                convoId = newConversation.rows[0].conversation_id;
            } else {
                convoId = conversation.rows[0].conversation_id;
            }
        }

        // Insert the message
        await db.query(
            "INSERT INTO messages (conversation_id, sender_uuid, recipient_uuid, content, timestamp) VALUES ($1, $2, $3, $4, NOW())",
            [convoId, senderUserId, recipientUserId, content]
        );

        // Update the latest_message column in the conversations table
        await db.query(
            'UPDATE conversations SET latest_message = $1, read = $2, updated_at = NOW() WHERE conversation_id = $3',
            [content, false, convoId]
        );

        res.status(201).json({ message: "Message sent successfully" });
    } catch (error) {
        console.error("Error sending message:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

module.exports = router;
