const express = require("express");
const db = require("./db");
const multer = require("multer");
const { S3 } = require("aws-sdk");
const crypto = require("crypto");

const router = express.Router();

// Configure multer for handling multipart/form-data
const upload = multer();

// Configure AWS S3 client
const s3 = new S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

// Function to calculate file hash
const calculateFileHash = (buffer) => {
    return crypto.createHash("sha256").update(buffer).digest("hex");
};

router.get("/messageStatus", (req, res) => {
    const status = {
        Status: "Message Routes Working",
    };

    res.send(status);
});

router.post(
    "/sendMessage",
    upload.fields([{ name: "files", maxCount: 10 }]),
    async (req, res) => {
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

        console.log("-----------------------");
        console.log("conversationTitle");
        const attachedFiles = req.files["files"];

        try {
            // Check if the sender exists in the users table
            let sender = await db.query(
                "SELECT * FROM users WHERE user_uuid = $1",
                [senderUserId]
            );

            if (sender.rowCount === 0) {
                // Insert the sender if they don't exist
                console.log("sender user doesn't exist, creating new user");
                await db.query(
                    "INSERT INTO users (user_uuid, name, email, created_at) VALUES ($1, $2, $3, NOW())",
                    [senderUserId, senderFullName, senderEmail]
                );
            } else if (!sender.rows[0].email) {
                // Update the sender if email is missing
                await db.query(
                    "UPDATE users SET email = $1 WHERE user_uuid = $2",
                    [senderEmail, senderUserId]
                );
            }

            // Check if the recipient exists in the users table
            let recipient = await db.query(
                "SELECT * FROM users WHERE user_uuid = $1",
                [recipientUserId]
            );

            if (recipient.rowCount === 0) {
                // Insert the recipient if they don't exist
                console.log("recipient user doesn't exist, creating new user");
                await db.query(
                    "INSERT INTO users (user_uuid, name, created_at) VALUES ($1, $2, NOW())",
                    [recipientUserId, recipientFullName]
                );
            }

            let convoId = conversationId && Number(conversationId);

            // Check if the conversation exists if conversationId is not provided or null
            if (!convoId) {
                const conversation = await db.query(
                    "SELECT * FROM conversations WHERE ((user1_uuid = $1 AND user2_uuid = $2) OR (user1_uuid = $2 AND user2_uuid = $1)) AND title = $3",
                    [senderUserId, recipientUserId, conversationTitle]
                );

                if (conversation.rowCount === 0) {
                    // Insert the conversation if it doesn't exist
                    console.log("convo doesn't exist, creating new");
                    const newConversation = await db.query(
                        "INSERT INTO conversations (user1_uuid, user2_uuid, title, latest_message, latest_message_sender, read, length, user1_name, user2_name, created_at, updated_at) VALUES ($1, $2, $3, $4, $1, $5, $6, $7, $8, NOW(), NOW()) RETURNING conversation_id",
                        [
                            senderUserId,
                            recipientUserId,
                            conversationTitle,
                            content,
                            false,
                            1,
                            senderFullName,
                            recipientFullName,
                        ]
                    );

                    convoId = newConversation.rows[0].conversation_id;
                } else {
                    convoId = conversation.rows[0].conversation_id;
                }
            } else {
                // Update the latest_message column in the conversations table
                await db.query(
                    "UPDATE conversations SET latest_message = $1, latest_message_sender = $2, read = $3, updated_at = NOW(), length = length + 1 WHERE conversation_id = $4",
                    [content, senderUserId, false, convoId]
                );
            }

            // Insert the message
            const messageQuery = `
                INSERT INTO messages (conversation_id, sender_uuid, recipient_uuid, content, timestamp) 
                VALUES ($1, $2, $3, $4, NOW()) RETURNING message_id
            `;
            const messageResult = await db.query(messageQuery, [
                convoId,
                senderUserId,
                recipientUserId,
                content,
            ]);

            const messageId = messageResult.rows[0].message_id;

            // Insert the file information
            if (attachedFiles && attachedFiles.length > 0) {
                for (const file of attachedFiles) {
                    const fileHash = calculateFileHash(file.buffer);

                    // Check if the file already exists in the database
                    const fileCheckQuery =
                        "SELECT * FROM files WHERE hash = $1";
                    const existingFile = await db.query(fileCheckQuery, [
                        fileHash,
                    ]);

                    let filePath;

                    if (existingFile.rowCount > 0) {
                        filePath = existingFile.rows[0].file_path;
                    } else {
                        // Upload new file to S3
                        const uploadParams = {
                            Bucket: process.env.S3_BUCKET_NAME,
                            Key: `${fileHash}-${file.originalname}`,
                            Body: file.buffer,
                            ContentType: file.mimetype,
                        };
                        const s3Response = await s3
                            .upload(uploadParams)
                            .promise();
                        filePath = s3Response.Location;

                        // Insert file metadata into the database
                        await db.query(
                            "INSERT INTO files (hash, file_path, file_name, created_at) VALUES ($1, $2, $3, NOW())",
                            [fileHash, filePath, file.originalname]
                        );
                    }

                    // Associate file with the message
                    await db.query(
                        "INSERT INTO message_files (message_id, file_path, file_name, created_at) VALUES ($1, $2, $3, NOW())",
                        [messageId, filePath, file.originalname]
                    );
                }
            }

            res.status(201).json({
                message: "Message sent successfully with files",
            });
        } catch (error) {
            console.error("Error sending message:", error);
            res.status(500).json({ error: "Internal Server Error" });
        }
    }
);

// read message
router.post("/readMessage", async (req, res) => {
    const { userId } = req;
    const { conversationId } = req.body;

    try {
        // Update the read column to true for the specified conversation
        await db.query(
            "UPDATE conversations SET read = true WHERE conversation_id = $1 AND (latest_message_sender != $2)",
            [conversationId, userId]
        );

        res.status(200).json({ message: "Conversation marked as read" });
    } catch (error) {
        console.error("Error marking conversation as read:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// inbox
router.get("/inbox/:userId", async (req, res) => {
    const { userId } = req.params;

    try {
        // Select all conversations where the userId is either user1_uuid or user2_uuid and userId is not the latest_message_sender
        const conversations = await db.query(
            "SELECT * FROM conversations WHERE (user1_uuid = $1 OR user2_uuid = $1) AND latest_message_sender != $1",
            [userId]
        );

        res.status(200).json(conversations.rows);
    } catch (error) {
        console.error("Error fetching inbox:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// sent
router.get("/sent/:userId", async (req, res) => {
    const { userId } = req.params;

    try {
        // Select all conversations where the userId is either user1_uuid or user2_uuid and userId is not the latest_message_sender
        const conversations = await db.query(
            "SELECT * FROM conversations WHERE (user1_uuid = $1 OR user2_uuid = $1) AND latest_message_sender = $1",
            [userId]
        );

        res.status(200).json(conversations.rows);
    } catch (error) {
        console.error("Error fetching inbox:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

module.exports = router;
