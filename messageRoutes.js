const express = require("express");
const db = require("./db");
const multer = require("multer");
const { S3 } = require("aws-sdk");
const crypto = require("crypto");
const cheerio = require("cheerio");

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
            title,
            message,
            attachedContentJson,
        } = req.body;

        const conversationTitle = title;
        const messageBody = message;

        const attachedFiles = req.files["files"];

        const attachedContent =
            attachedContentJson && JSON.parse(attachedContentJson);
        console.log(attachedContent);

        try {
            console.log("Checking if sender exists");
            let sender = await db.query(
                "SELECT * FROM users WHERE user_uuid = $1",
                [senderUserId]
            );

            if (sender.rowCount === 0) {
                console.log("Sender does not exist, creating new user");
                await db.query(
                    "INSERT INTO users (user_uuid, name, email, created_at) VALUES ($1, $2, $3, NOW())",
                    [senderUserId, senderFullName, senderEmail]
                );
            } else if (!sender.rows[0].email) {
                console.log("Sender exists, updating email if missing");
                await db.query(
                    "UPDATE users SET email = $1 WHERE user_uuid = $2",
                    [senderEmail, senderUserId]
                );
            }

            console.log("Checking if recipient exists");
            let recipient = await db.query(
                "SELECT * FROM users WHERE user_uuid = $1",
                [recipientUserId]
            );

            if (recipient.rowCount === 0) {
                console.log("Recipient does not exist, creating new user");
                await db.query(
                    "INSERT INTO users (user_uuid, name, created_at) VALUES ($1, $2, NOW())",
                    [recipientUserId, recipientFullName]
                );
            }

            let convoId = conversationId && Number(conversationId);

            function stripHTML(html) {
                const $ = cheerio.load(html);
                return $("body").text();
            }

            let messageBodyStrippedHTML = stripHTML(messageBody);

            if (!convoId) {
                console.log("Checking if conversation exists");
                const conversation = await db.query(
                    "SELECT * FROM conversations WHERE ((user1_uuid = $1 AND user2_uuid = $2) OR (user1_uuid = $2 AND user2_uuid = $1)) AND title = $3",
                    [senderUserId, recipientUserId, conversationTitle]
                );

                if (conversation.rowCount === 0) {
                    console.log(
                        "Conversation does not exist, creating new conversation"
                    );
                    const newConversation = await db.query(
                        "INSERT INTO conversations (user1_uuid, user2_uuid, title, latest_message, latest_message_sender, read, length, user1_name, user2_name, created_at, updated_at) VALUES ($1, $2, $3, $4, $1, $5, $6, $7, $8, NOW(), NOW()) RETURNING conversation_id",
                        [
                            senderUserId,
                            recipientUserId,
                            conversationTitle,
                            messageBodyStrippedHTML,
                            false,
                            1,
                            senderFullName,
                            recipientFullName,
                        ]
                    );

                    convoId = newConversation.rows[0].conversation_id;
                } else {
                    console.log("Conversation exists");
                    convoId = conversation.rows[0].conversation_id;
                }
            } else {
                console.log("Updating latest message in conversation");
                await db.query(
                    "UPDATE conversations SET latest_message = $1, latest_message_sender = $2, read = $3, updated_at = NOW(), length = length + 1 WHERE conversation_id = $4",
                    [messageBody, senderUserId, false, convoId]
                );
            }

            console.log("Inserting message");
            const messageResult = await db.query(
                "INSERT INTO messages (conversation_id, sender_uuid, recipient_uuid, message_body, attached_content, timestamp) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING message_id",
                [
                    convoId,
                    senderUserId,
                    recipientUserId,
                    messageBody,
                    attachedContent,
                ]
            );
            const messageId = messageResult.rows[0].message_id;

            if (attachedFiles && attachedFiles.length > 0) {
                console.log("Processing attached files");
                for (const file of attachedFiles) {
                    const hash = crypto
                        .createHash("sha256")
                        .update(file.buffer)
                        .digest("hex");
                    const s3Key = `uploads/${hash}-${file.originalname}`;

                    console.log("Uploading file to S3:", s3Key);
                    await s3
                        .upload({
                            Bucket: process.env.S3_BUCKET_NAME,
                            Key: s3Key,
                            Body: file.buffer,
                            ContentType: file.mimetype,
                        })
                        .promise();

                    console.log("Inserting file metadata into files table");
                    const fileResult = await db.query(
                        "INSERT INTO files (hash, file_path, file_name, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (hash) DO NOTHING RETURNING file_id",
                        [hash, s3Key, file.originalname]
                    );

                    let fileId;
                    if (fileResult.rows.length > 0) {
                        fileId = fileResult.rows[0].file_id;
                    } else {
                        const existingFile = await db.query(
                            "SELECT file_id FROM files WHERE hash = $1",
                            [hash]
                        );
                        fileId = existingFile.rows[0].file_id;
                    }

                    console.log(
                        "Linking file to message in message_files table"
                    );
                    await db.query(
                        "INSERT INTO message_files (message_id, file_id, created_at) VALUES ($1, $2, NOW())",
                        [messageId, fileId]
                    );
                }
            }

            res.status(201).json({ message: "Message sent successfully" });
        } catch (error) {
            console.error("Error sending message:", error);
            res.status(500).json({ error: "Internal Server Error" });
        }
    }
);

// read message
router.post("/readMessage/:conversationId", async (req, res) => {
    const { userId } = req;
    const { conversationId } = req.params;

    try {
        // Update the read column to true for the specified conversation
        await db.query(
            "UPDATE conversations SET read = true WHERE conversation_id = $1",
            [conversationId]
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
        // Select all conversations where the userId is either user1_uuid or user2_uuid and length > 1
        const conversations = await db.query(
            "SELECT * FROM conversations WHERE (user1_uuid = $1 OR user2_uuid = $1) AND NOT (length = 1 AND latest_message_sender = $1)",
            [userId]
        );

        // Modify the conversations to mark them as read if the user was the last sender
        const modifiedConversations = conversations.rows.map(conversation => {
            if (!conversation.read && conversation.latest_message_sender === userId) {
                conversation.read = true;
            }
            return conversation;
        });

        res.status(200).json(modifiedConversations);
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
            "SELECT * FROM conversations WHERE (user1_uuid = $1 OR user2_uuid = $1) AND (length = 1 AND latest_message_sender = $1)",
            [userId]
        );

        res.status(200).json(conversations.rows);
    } catch (error) {
        console.error("Error fetching inbox:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// load conversation
router.get("/conversation/:conversationId", async (req, res) => {
    const { conversationId } = req.params;

    try {
        // Select all messages matching conversation id and sort by timestamp ascending
        const messagesResult = await db.query(
            "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY timestamp ASC",
            [conversationId]
        );

        const messages = messagesResult.rows;

        // Iterate through messages to find and add attached files
        for (const message of messages) {
            const messageId = message.message_id;

            // Find file_ids linked to the message
            const messageFilesResult = await db.query(
                "SELECT file_id FROM message_files WHERE message_id = $1",
                [messageId]
            );
            const fileIds = messageFilesResult.rows.map((row) => row.file_id);
            message.file_ids = fileIds;

            // Find file_paths for each file_id
            if (fileIds.length > 0) {
                const files = [];
                for (const fileId of fileIds) {
                    // Query the files table to get the file_path for the fileId
                    const fileQueryResult = await db.query(
                        "SELECT file_path, file_name FROM files WHERE file_id = $1",
                        [fileId]
                    );
                    if (fileQueryResult.rows.length > 0) {
                        const fileName = fileQueryResult.rows[0].file_name;
                        const filePath = fileQueryResult.rows[0].file_path;
                        // Generate S3 URL for the file
                        const params = {
                            Bucket: process.env.S3_BUCKET_NAME,
                            Key: filePath,
                            Expires: 3600, // URL expiration time in seconds (adjust as needed)
                        };
                        const url = s3.getSignedUrl("getObject", params);
                        files.push({fileName, url});
                    }
                }
                message.files = files;
            } else {
                message.files = [];
            }
        }

        res.status(200).json(messages);
    } catch (error) {
        console.error("Error fetching messages:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

module.exports = router;
