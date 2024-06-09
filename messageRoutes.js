const express = require("express");
const db = require("./db");
const multer = require("multer");
const { S3 } = require("aws-sdk");
const crypto = require("crypto");
const cheerio = require("cheerio");
const axios = require("axios");
const { v4: uuidv4 } = require('uuid'); // import the UUID library

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
        let {
            recipientFullName,
            recipientUserId,
            conversationId,
            title,
            message,
            attachedContentJson,
        } = req.body;

        const conversationTitle = title;
        const messageBody = message === "null" ? "" : message;

        const attachedFiles = req.files["files"];

        const attachedContent =
            attachedContentJson && JSON.parse(attachedContentJson);
        console.log(attachedContent);

        let convoId = conversationId && Number(conversationId);

        try {
            function stripHTML(html) {
                const $ = cheerio.load(html);
                return $("body").text();
            }

            let messageBodyStrippedHTML = stripHTML(messageBody);

            if (!convoId) {

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
                console.log("Checking if conversation with conversationId exists");

                const conversation = await db.query(
                    "SELECT * FROM conversations WHERE conversation_id = $1",
                    [convoId]
                );

                if (conversation.rowCount === 0) {
                    console.log(
                        "Conversation with supplied conversation ID does not exist"
                    );
                } else {
                    console.log("Conversation found");
                    recipientUserId = conversation.rows[0].user1_uuid === senderUserId ? conversation.rows[0].user2_uuid : conversation.rows[0].user1_uuid;
                }

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
    const {
        userId: userIdSession
    } = req;

    if (userId !== userIdSession) {
        console.error("Error fetching inbox: not authorized to view another user's inbox");
        res.status(401).json({ error: "Not authorized to view another user's inbox" });
    }

    try {
        // Select all conversations where the userId is either user1_uuid or user2_uuid and length > 1
        const conversations = await db.query(
            "SELECT * FROM conversations WHERE (user1_uuid = $1 OR user2_uuid = $1) AND NOT (length = 1 AND latest_message_sender = $1)",
            [userId]
        );

        // Modify the conversations to mark them as read if the user was the last sender
        const modifiedConversations = conversations.rows.map((conversation) => {
            if (
                !conversation.read &&
                conversation.latest_message_sender === userId
            ) {
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
    const {
        userId: userIdSession
    } = req;

    if (userId !== userIdSession) {
        console.error("Error fetching inbox: not authorized to view another user's inbox");
        res.status(401).json({ error: "Not authorized to view another user's inbox" });
    }

    try {
        // Select all conversations where the userId is either user1_uuid or user2_uuid and userId is not the latest_message_sender
        const conversations = await db.query(
            "SELECT * FROM conversations WHERE (user1_uuid = $1 OR user2_uuid = $1) AND (length = 1 AND latest_message_sender = $1)",
            [userId]
        );

        // Modify the conversations to mark them as read if the user was the last sender
        const modifiedConversations = conversations.rows.map((conversation) => {
            if (
                !conversation.read &&
                conversation.latest_message_sender === userId
            ) {
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

// load conversation
router.get("/conversation/:conversationId", async (req, res) => {
    const { conversationId } = req.params;
    const token = req.token;

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
                        files.push({ fileId, fileName, url });
                    }
                }
                message.files = files;
            } else {
                message.files = [];
            }

            if (message.attached_content?.length > 0) {
                message.content = await fetchContentItems(
                    message.attached_content,
                    token
                );
            }
        }

        res.status(200).json(messages);
    } catch (error) {
        console.error("Error fetching messages:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

//delete conversation
router.post("/conversation/delete/:conversationId", async (req, res) => {
    const { conversationId } = req.params;

    try {
        // Start a transaction
        await db.query("BEGIN");

        // Get file_ids and file_paths before deleting the conversation
        const filesResult = await db.query(
            `SELECT f.file_id, f.file_path 
             FROM files f
             INNER JOIN message_files mf ON f.file_id = mf.file_id
             INNER JOIN messages m ON mf.message_id = m.message_id
             WHERE m.conversation_id = $1`,
            [conversationId]
        );

        const fileIds = filesResult.rows.map(row => row.file_id);

        // Delete the conversation (cascades to delete messages and message_files)
        await db.query("DELETE FROM conversations WHERE conversation_id = $1", [conversationId]);

        // Check if the file_ids are still referenced in the message_files table
        const unreferencedFilesResult = await db.query(
            `SELECT f.file_id, f.file_path 
             FROM files f 
             LEFT JOIN message_files mf ON f.file_id = mf.file_id 
             WHERE f.file_id = ANY($1::int[]) AND mf.file_id IS NULL`,
            [fileIds]
        );

        const unreferencedFiles = unreferencedFilesResult.rows;

        // Delete unreferenced files from S3 and the files table
        for (const file of unreferencedFiles) {
            const params = {
                Bucket: process.env.S3_BUCKET_NAME,
                Key: file.file_path
            };

            // Delete file from S3
            await s3.deleteObject(params).promise();

            // Delete file record from files table
            await db.query("DELETE FROM files WHERE file_id = $1", [file.file_id]);
        }

        // Commit transaction
        await db.query("COMMIT");

        res.status(200).json({ message: "Conversation and related files deleted successfully" });
    } catch (error) {
        // Rollback transaction in case of error
        await db.query("ROLLBACK");
        console.error("Error deleting conversation:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

//----- Adding test support for multiple users in conversations

router.post(
    "/sendMessageUsers",
    upload.fields([{ name: "files", maxCount: 10 }]),
    async (req, res) => {
        const {
            userId: senderUserId,
            userFullName: senderFullName,
            userEmail: senderEmail,
        } = req;
        let {
            conversationId,
            title,
            message,
            attachedContentJson,
            users,
        } = req.body;

        const conversationTitle = title;
        const messageBody = message === "null" ? "" : message;
        const usersArray = users && JSON.parse(users);
        const uuids = usersArray && usersArray.map(user => user.uuid);
        const sortedIds = uuids && uuids.sort();
        const attachedFiles = req.files["files"];
        const attachedContent = attachedContentJson && JSON.parse(attachedContentJson);

        console.log(attachedContent);

        let convoId = conversationId && Number(conversationId);

        try {
            await db.query("BEGIN");

            function stripHTML(html) {
                const $ = cheerio.load(html);
                return $("body").text();
            }

            let messageBodyStrippedHTML = stripHTML(messageBody);

            if (!convoId) {
                for (const user of usersArray) {
                    if (user.uuid === senderUserId) {
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
                    } else {
                        console.log("Checking if recipient exists");
                        let recipient = await db.query(
                            "SELECT * FROM users WHERE user_uuid = $1",
                            [user.uuid]
                        );

                        if (recipient.rowCount === 0) {
                            console.log("Recipient does not exist, creating new user");
                            await db.query(
                                "INSERT INTO users (user_uuid, name, created_at) VALUES ($1, $2, NOW())",
                                [user.uuid, user.name]
                            );
                        }
                    }
                }

                console.log("Checking if conversation exists");
                const conversation = await db.query(
                    `SELECT * FROM conversations WHERE title = $1 AND sorted_uuids = $2::uuid[]`,
                    [conversationTitle, arrayToPostgresArray(sortedIds)]
                );

                if (conversation.rowCount === 0) {
                    console.log("Conversation does not exist, creating new conversation");
                    const newConversation = await db.query(
                        "INSERT INTO conversations (users, title, latest_message, latest_message_sender, length, sorted_uuids, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW()) RETURNING conversation_id",
                        [
                            users,
                            conversationTitle,
                            messageBodyStrippedHTML,
                            senderUserId,
                            1,
                            sortedIds
                        ]
                    );

                    convoId = newConversation.rows[0].conversation_id;
                } else {
                    console.log("Conversation exists");
                    convoId = conversation.rows[0].conversation_id;

                    console.log("Updating latest message in conversation");
                    await db.query(
                        "UPDATE conversations SET latest_message = $1, latest_message_sender = $2, read_by = $3, updated_at = NOW(), length = length + 1 WHERE conversation_id = $4",
                        [messageBody, senderUserId, [], convoId]
                    );
                }
            } else {
                console.log("Checking if conversation with conversationId exists");

                const conversation = await db.query(
                    "SELECT * FROM conversations WHERE conversation_id = $1",
                    [convoId]
                );

                if (conversation.rowCount === 0) {
                    console.log("Conversation with supplied conversation ID does not exist");
                    res.status(500).json({ error: "Conversation with supplied conversation ID does not exist" });
                } else {
                    console.log("Conversation found");
                }

                console.log("Updating latest message in conversation");
                await db.query(
                    "UPDATE conversations SET latest_message = $1, latest_message_sender = $2, read_by = $3, updated_at = NOW(), length = length + 1 WHERE conversation_id = $4",
                    [messageBody, senderUserId, [], convoId]
                );
            }

            console.log("Inserting message");
            const messageResult = await db.query(
                "INSERT INTO messages (conversation_id, sender_uuid, message_body, attached_content, timestamp) VALUES ($1, $2, $3, $4, NOW()) RETURNING message_id",
                [
                    convoId,
                    senderUserId,
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
                    await s3.upload({
                        Bucket: process.env.S3_BUCKET_NAME,
                        Key: s3Key,
                        Body: file.buffer,
                        ContentType: file.mimetype,
                    }).promise();

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

                    console.log("Linking file to message in message_files table");
                    await db.query(
                        "INSERT INTO message_files (message_id, file_id, created_at) VALUES ($1, $2, NOW())",
                        [messageId, fileId]
                    );
                }
            }

            await db.query("COMMIT");
            res.status(201).json({ message: "Message sent successfully" });
        } catch (error) {
            await db.query("ROLLBACK");
            console.error("Error sending message:", error);
            res.status(500).json({ error: "Internal Server Error" });
        }
    }
);


// read message using read_by uuid array
router.post("/readMessageUsers/:conversationId", async (req, res) => {
    const { userId } = req; // Assuming userId is available in req object
    const { conversationId } = req.params;

    try {
        // Fetch the current read_by array
        const { rows } = await db.query(
            "SELECT read_by FROM conversations WHERE conversation_id = $1",
            [conversationId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Conversation not found" });
        }

        let readBy = rows[0].read_by || [];

        // Check if userId is already in the read_by array
        if (!readBy.includes(userId)) {
            readBy.push(userId);

            // Update the read_by array in the database
            await db.query(
                "UPDATE conversations SET read_by = $1 WHERE conversation_id = $2",
                [readBy, conversationId]
            );
        }

        res.status(200).json({ message: "Conversation marked as read" });
    } catch (error) {
        console.error("Error marking conversation as read:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// messages for mobile view
router.get("/messages", async (req, res) => {
    const { userId } = req;

    try {
        // Convert userId to UUID
        const userIdAsUUID = uuidv4(userId);
        
        // Select all conversations where the userId is included in the users array
        const conversations = await db.query(
            `SELECT * FROM conversations WHERE $1 = ANY(sorted_uuids)`,
            [userId]
        );

        // Modify the conversations to mark them as read if the user was the last sender
        const modifiedConversations = conversations.rows.map((conversation) => {
            if (
                conversation.read_by.includes(userId) &&
                conversation.latest_message_sender === userId
            ) {
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

// Helper Functions

async function fetchContentItems(contentIds, token) {
    try {
        const response = await axios.post(
            "https://content-microservice-stg-613843a26cb6.herokuapp.com/content/ids",
            {
                contentIds: contentIds,
            },
            {
                headers: {
                    Authorization: token,
                    "Content-Type": "application/json",
                },
            }
        );

        if (response.data.length > 0) {
            return response.data;
        } else {
            console.log("No content items found.");
        }
    } catch (error) {
        console.error(
            "Error fetching content items:",
            error.response ? error.response.data : error.message
        );
    }
}

function arrayToPostgresArray(array) {
    // Join the elements with commas and wrap them in curly braces
    const correctedArray = `{${array.join(',')}}`;
    return correctedArray;
}

module.exports = router;
