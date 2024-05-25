async function GetUserAttachments(userId) {
    let response = await axios.post(
        "https://zala-stg.herokuapp.com/gql",
        {
            query: `
            query GetUserAttachments($userId: ID!) {
                user(id: $userId) {
                    attachments(labels: ["profile_picture"]) {
                        id
                        label
                        contentUrl
                    }
                }
            }
            `,
            variables: {
                userId: userId, // Pass the userId variable here
            },
        },
        {
            headers: {
                Authorization: token,
                "Content-Type": "application/json",
            },
        }
    );

    // If the request is successful, assign the response data to user1ProfilePic
    return response.data.data.user.attachments;
}
