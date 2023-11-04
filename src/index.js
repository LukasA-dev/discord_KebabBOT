// Load environment variables from .env file
require("dotenv").config({ path: "C:/DiscordBot/.env" });

// Constants
// Data base constants
const DB_NAME = "discordBot";
const COLLECTION_NAME = "lolAccs";

// Scraping constants
const axios = require("axios");
const cheerio = require("cheerio"); 

// Audio constants
const ffmpeg = require("ffmpeg-static");
const ytdl = require("ytdl-core");
const scdl = require("soundcloud-downloader");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
} = require("@discordjs/voice");

// Import clients
const { MongoClient } = require("mongodb");
const { Client, GatewayIntentBits } = require("discord.js");

// Global variables
const prefix = "k!";
const voiceConnections = new Map(); // To store voice connections by guild ID
const songQueue = new Map(); // Map to hold the song queue for each server
const voiceActivityIntervals = {};
let lolAccsCollection;
let voiceConnection;
let voiceActivityCollection;

// Connect to MongoDB
async function connectToMongo() {
  const uri = process.env.MONGO_URI;
  const clientDB = new MongoClient(uri);

  try {
    await clientDB.connect();
    console.log("Connected to MongoDB");
    return clientDB.db("discordBot");
  } catch (err) {
    console.error(err);
    process.exit(1); // Exit the process if the database connection fails
  }
}

// Declare client intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Utility functions for audio
function play(guild, song) {
  const serverQueue = songQueue.get(guild.id);
  if (!song) {
    if (
      serverQueue.voiceChannel &&
      typeof serverQueue.voiceChannel.leave === "function"
    ) {
      serverQueue.voiceChannel.leave();
    }
    songQueue.delete(guild.id);
    return;
  }

  try {
    const resource = createAudioResource(
      ytdl(song.url, { filter: "audioonly" })
    );
    serverQueue.player.play(resource);
  } catch (error) {
    console.error("Error creating audio resource:", error);
  }
  serverQueue.player.on(AudioPlayerStatus.Idle, () => {
    console.log("Player went idle. Current queue:", serverQueue.songs);
    serverQueue.songs.shift();
    play(guild, serverQueue.songs[0]);
  });

  serverQueue.player.on("error", (error) => {
    console.error("Error in audio player:", error);
    console.error(`Error in audio player: ${error}`);
  });

  serverQueue.textChannel.send(`Start playing: **${song.title}**`);
}

function skip(message, serverQueue) {
  if (!serverQueue)
    return message.channel.send("There is no song that I could skip!");
  if (serverQueue.songs.length > 1) {
    serverQueue.songs.shift(); // Remove the current song from the queue
    play(message.guild, serverQueue.songs[0]); // Play the next song
  } else {
    serverQueue.connection.dispatcher.end(); // If there's only one song, just end the dispatcher
  }
}

function stop(message, serverQueue) {
  if (!serverQueue) {
    return message.channel.send("There is no queue to stop.");
  }

  // Clear the queue
  serverQueue.songs = [];

  // End the dispatcher if it exists
  if (serverQueue.connection && serverQueue.connection.dispatcher) {
    serverQueue.connection.dispatcher.end();
  }

  // Remove the serverQueue from the map
  songQueue.delete(message.guild.id);

  // Send a message indicating the queue has been cleared
  return message.channel.send("Stopped the music and cleared the queue.");
}
//Function to clear the queue
function clearQueue(message, serverQueue) {
  if (!serverQueue) {
    return message.channel.send("There is no queue to clear.");
  }

  // Clear the queue
  serverQueue.songs = [];

  // Send a message indicating the queue has been cleared
  return message.channel.send("Cleared the queue.");
}

// Scraping opgg functions
async function fetchRankFromOPGG(summonerName, region = "euw") {
  try {
    const response = await axios.get(
      `https://${region}.op.gg/summoner/userName=${encodeURI(summonerName)}`
    );
    const $ = cheerio.load(response.data);
    let rankInfo = {
      rank: "Unranked",
      lp: "0 LP",
      winRate: "0%",
    };

    // Loop through each div that has a header class
    $("div.header").each((i, elem) => {
      // Check if the header text is "Ranked Solo"
      if ($(elem).text().trim() === "Ranked Solo") {
        // Navigate to the parent and then find the div with class tier, lp and ratio.
        const parentDiv = $(elem).parent();
        rankInfo.rank = parentDiv.find("div.tier").first().text().trim();
        rankInfo.lp = parentDiv.find("div.lp").first().text().trim();
        rankInfo.winRate = parentDiv
          .find("div.ratio")
          .first()
          .text()
          .trim()
          .split(" ")[2]; // Extracting only the percentage
        return false; // Break the loop
      }
    });

    return `${summonerName} is ${rankInfo.rank}, ${rankInfo.lp} with a ${rankInfo.winRate} winrate`;
  } catch (error) {
    console.error("Error fetching rank from OPGG:", error);
    return null;
  }
}

// Time conversion function
function msToTime(duration) {
  const minutes = Math.floor((duration / (1000 * 60)) % 60);
  const hours = Math.floor((duration / (1000 * 60 * 60)) % 24);

  const formattedHours = hours < 10 ? "0" + hours : hours;
  const formattedMinutes = minutes < 10 ? "0" + minutes : minutes;

  return `${formattedHours}:${formattedMinutes}`;
}

// Initialize bot
client.once("ready", async () => {
  console.log("Bot is online!");
  try {
    const db = await connectToMongo();
    lolAccsCollection = db.collection("lolAccs");
    voiceActivityCollection = db.collection("voiceActivity"); // Initialize here
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  }

  if (client.voiceConnections) {
    client.voiceConnections.each((connection) => {
      initializeVoiceConnection(connection);
    });
  } else {
    console.error("client.voiceConnections is undefined");
  }
});

console.log("Voice connections:", client.voiceConnections);

// Function to initialize voice connection
function initializeVoiceConnection(connection) {
  // Remove existing listeners if any
  connection.removeAllListeners("stateChange");
  connection.removeAllListeners("error");

  // Attach new listeners
  connection.on("stateChange", (oldState, newState) => {
    console.log(
      `Voice connection state changed: ${oldState.status} -> ${newState.status}`
    );
  });

  connection.on("error", (error) => {
    console.error(`Voice connection error: ${error}`);
  });
}

// Main bot logic
client.on("messageCreate", async (message) => {
  // Ignore messages from bots
  if (message.author.bot) return;

  //Logs
  console.log(`Received message: ${message.content}`);

  // Check if the message starts with the command prefix
  if (message.content.startsWith(prefix)) {
    // Check if the MongoDB collection is available
    if (!lolAccsCollection) {
      return message.reply("wtf jag når inte databasen LOL");
    }

    // Parse the message into command and arguments
    let args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // Initialize username variable
    let username;

    // Check if a user is mentioned in the message
    if (message.mentions.users.first()) {
      username = message.mentions.users.first().id;
      args = args.slice(1); // Remove the mentioned user from the arguments
    } else {
      username = message.author.id; // Use the message author's ID if no user is mentioned
    }

    // Handle all bot commands
    if (command === "lolaccs") {
      const subCommand = args.shift(); // Extract the sub-command
      const accounts = args
        .join(" ")
        .split(",")
        .map((acc) => acc.trim()); // Parse the accounts

      // Check permissions for 'add', 'remove', and 'clear' sub-commands
      if (
        ["add", "remove", "clear"].includes(subCommand) &&
        username !== message.author.id
      ) {
        return message.reply("Ajjabajja inte så");
      }

      // If no sub-command is provided, query for accounts
      if (!subCommand) {
        const userAccs = await lolAccsCollection.findOne({ username });
        if (userAccs && userAccs.accounts.length > 0) {
          return message.reply(
            `<@${username}> pisslåga skitkonton är  ${userAccs.accounts.join(
              ", "
            )}`
          );
        } else {
          return message.reply(`<@${username}> har inte ens några skitkonton`);
        }
      }

      // Validate the sub-command
      if (!["add", "remove", "clear"].includes(subCommand)) {
        return message.reply(
          "bror är du dum? testa med add, remove, clear din luffare ;)"
        );
      }

      // Handle add sub-command
      if (subCommand === "add") {
        await lolAccsCollection.updateOne(
          { username },
          { $addToSet: { accounts: { $each: accounts } } },
          { upsert: true }
        );
        const updatedAccs = await lolAccsCollection.findOne({ username });
        message.reply(
          `Dina konton har uppdaterats, din nya pisslow lista: ${updatedAccs.accounts.join(
            ", "
          )}`
        );
      }

      // Handle remove sub-command
      else if (subCommand === "remove") {
        const result = await lolAccsCollection.updateOne(
          { username },
          { $pull: { accounts: { $in: accounts } } }
        );
        if (result.modifiedCount === 0) {
          return message.reply(
            "Inte ens ett endaste konto hittades att ta bort..."
          );
        }
        const updatedAccs = await lolAccsCollection.findOne({ username });
        message.reply(
          `Dina konton har uppdaterats, din nya pisslow lista: ${updatedAccs.accounts.join(
            ", "
          )}`
        );
      }

      // Handle clear sub-command
      else if (subCommand === "clear") {
        await lolAccsCollection.updateOne(
          { username },
          { $set: { accounts: [] } }
        );
        message.reply("Dina konton blev wipade LOL.");
      }
    } else if (command === "play") {
      const voiceChannel = message.member.voice.channel;
      if (!voiceChannel)
        return message.channel.send("Join a voice channel first!");

      let serverQueue = songQueue.get(message.guild.id);

      const songInfo = await ytdl.getInfo(args[0]);
      const song = {
        title: songInfo.videoDetails.title,
        url: songInfo.videoDetails.video_url,
      };

      // Check if serverQueue exists or if the bot is not in a voice channel
      if (
        !serverQueue ||
        !serverQueue.connection ||
        serverQueue.connection.state.status !== VoiceConnectionStatus.Ready
      ) {
        // Create a new queue and join the voice channel
        const queueConstruct = {
          textChannel: message.channel,
          voiceChannel: voiceChannel,
          connection: null,
          songs: [],
          player: createAudioPlayer(),
        };

        songQueue.set(message.guild.id, queueConstruct);
        queueConstruct.songs.push(song);

        try {
          const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
          });
          queueConstruct.connection = connection;
          connection.subscribe(queueConstruct.player);
          play(message.guild, queueConstruct.songs[0]);

          // Initialize the voice connection
          initializeVoiceConnection(connection);
        } catch (err) {
          console.log(err);
          songQueue.delete(message.guild.id);
          return message.channel.send(err);
        }
      } else {
        serverQueue.songs.push(song);
        return message.channel.send(
          `${song.title} has been added to the queue!`
        );
      }
    } else if (command === "stop") {
      try {
        console.log("Stop command triggered");

        // Get the server queue
        const serverQueue = songQueue.get(message.guild.id);
        console.log("Server Queue:", serverQueue);

        // First, stop the server and clear the song queue
        stop(message, serverQueue);

        // Then, check if the bot is in a voice channel and disconnect
        if (serverQueue && serverQueue.connection) {
          serverQueue.connection.disconnect();
          message.reply("Kebab BOT has stopped jamming.");
        } else {
          message.reply("Jag är inte ens i en kanal XDD.");
        }
      } catch (error) {
        console.error("Error in stop command:", error);
        message.reply("An error occurred while trying to stop the music.");
      }
    } else if (command === "q") {
      const serverQueue = songQueue.get(message.guild.id);
      if (!serverQueue || serverQueue.songs.length === 0) {
        return message.channel.send("Kön är tom yäni");
      }
      const songList = serverQueue.songs
        .map((song, index) => `${index + 1}. ${song.title}`)
        .join("\n");
      return message.channel.send(`Current queue:\n${songList}`);
    } else if (command === "skip") {
      const serverQueue = songQueue.get(message.guild.id);
      if (!serverQueue) {
        return message.channel.send("Blud tror man kan skippa luft :skull:");
      }
      skip(message, serverQueue);
    } else if (command === "qclear") {
      const serverQueue = songQueue.get(message.guild.id);
      clearQueue(message, serverQueue);
    } else if (command === "rank") {
      let summonerName = args.slice(0, -1).join(" ");
      let region = args[args.length - 1].toUpperCase();

      // If only one argument is provided, it's the summoner name and the region is EUW
      if (args.length === 1) {
        summonerName = args[0];
        region = "EUW";
      }

      if (!summonerName) {
        return message.reply(
          "Please provide a summoner name. Usage: k!rank [SummonerName] [Region]"
        );
      }

      try {
        const rankDetails = await fetchRankFromOPGG(
          summonerName,
          region.toLowerCase()
        );
        return message.reply(rankDetails);
      } catch (error) {
        console.error("Error fetching rank:", error);
        return message.reply("An error occurred while fetching the rank.");
      }
    } else if (command === "help") {
      const detailedCommand = args[0];

      if (!detailedCommand) {
        return message.channel.send(
          "Available commands:\n" +
            "- `k!lolaccs`: Hantera dina fakking lolkonton. Subcommands: `add`, `remove`, `clear`\n" +
            "- `k!play [URL]`: Jamma en youtubelåt.\n" +
            "- `k!stop`: Stannar musiken och lämnar voice.\n" +
            "- `k!skip`: Skippa låten\n" +
            "- `k!q`: Visar låtlistan.\n" +
            "- `k!qclear`: Rensar låtlistan.\n" +
            "- `k!rank [SummonerName] [Region]`: Hämta någon tjommes rank.\n" +
            "För mer detaljerade beskrivningar, använd `k!help [command]`."
        );
      }

      const helpDetails = {
        lolaccs:
          "Hantera dina fakking lolkonton. Subcommands: `add [account1, account2, ...]`, `remove [account1, account2, ...]`, `clear`",
        play: "Jamma en youtubelåt. Usage: `k!play [URL]`",
        stop: "Stannar musiken och lämnar voice.",
        skip: "Skippa låten",
        q: "Visar låtlistan",
        qclear: "Rensar låtlistan.",
        rank: "Hämta någon tjommes rank. Usage: `k!rank [SummonerName] [Region]`",
      };

      const detailedHelp = helpDetails[detailedCommand];
      if (detailedHelp) {
        return message.channel.send(
          `Detaljer för commandet \`${detailedCommand}\`: ${detailedHelp}`
        );
      } else {
        return message.channel.send(
          "Okänt command. Testa `k!help` för att se alla commands."
        );
      }
    } else if (command === "timespent") {
      let userId;
      let showTotal = false;

      if (args[0] === "total") {
        showTotal = true;
        args.shift(); // Remove the "total" argument
      }

      if (message.mentions.users.first()) {
        userId = message.mentions.users.first().id;
      } else {
        userId = message.author.id;
      }

      const guildId = message.guild.id;
      console.log(
        `Fetching voice activity for user ${userId} in guild ${guildId}`
      );

      const activity = await voiceActivityCollection.findOne({
        userId,
        guildId,
      });

      if (activity) {
        const timeSpent = activity.timeSpent;
        const totalTimeSpent = activity.totalTimeSpent || 0; // Use 0 if totalTimeSpent doesn't exist yet
        const readableTime = msToTime(timeSpent);
        const readableTotalTime = msToTime(totalTimeSpent);

        if (showTotal) {
          message.reply(
            `<@${userId}> har totalt wastat ${readableTotalTime} i safespace :skull:`
          );
        } else {
          message.reply(
            `<@${userId}> har wastat ${readableTime} i safespace denna session :skull:`
          );
        }
      } else {
        message.reply(
          `No voice activity recorded for <@${userId}> on this server.`
        );
      }
    }
  }
});

// Track time for voice activity
client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    console.log("voiceStateUpdate triggered"); // Debugging line

    const userId = newState.member.id;
    const guildId = newState.guild.id;
    const userGuildKey = `${userId}-${guildId}`;

    console.log(`UserGuildKey: ${userGuildKey}`); // Debugging line

    if (!oldState.channelId && newState.channelId) {
      console.log("User joined a voice channel"); // Debugging line

      const joinedAt = new Date();
      voiceConnections.set(userGuildKey, joinedAt);

      console.log(`Set joinedAt for ${userGuildKey} to ${joinedAt}`); // Debugging line

      await voiceActivityCollection
        .updateOne(
          { userId, guildId },
          { $set: { joinedAt } },
          { upsert: true }
        )
        .catch((err) => console.error("MongoDB updateOne error:", err)); // Error logging

      console.log("MongoDB updated for user join"); // Debugging line

      voiceActivityIntervals[userGuildKey] = setInterval(async () => {
        console.log(`Updating time for user ${userId} in guild ${guildId}`); // Debugging line

        const currentTime = new Date();
        const joinedAt = voiceConnections.get(userGuildKey);
        const timeSpent = currentTime - joinedAt;

        const activity = await voiceActivityCollection
          .findOne({ userId, guildId })
          .catch((err) => console.error("MongoDB findOne error:", err)); // Error logging

        const totalTimeSpent = (activity?.totalTimeSpent || 0) + timeSpent;

        await voiceActivityCollection
          .updateOne(
            { userId, guildId },
            { $set: { timeSpent, totalTimeSpent } },
            { upsert: true }
          )
          .catch((err) => console.error("MongoDB updateOne error:", err)); // Error logging

        console.log("MongoDB updated for time spent"); // Debugging line
      }, 2000);
    } else if (oldState.channelId && !newState.channelId) {
      console.log("User left a voice channel"); // Debugging line

      voiceConnections.delete(userGuildKey);
      clearInterval(voiceActivityIntervals[userGuildKey]);
      delete voiceActivityIntervals[userGuildKey];

      // Update totalTimeSpent atomically
      await voiceActivityCollection
        .updateOne(
          { userId, guildId },
          { $inc: { totalTimeSpent: timeSpent } } // $inc will atomically increment totalTimeSpent by timeSpent
        )
        .catch((err) => console.error("MongoDB updateOne error:", err));

      console.log("MongoDB updated for user leave"); // Debugging line
    }
  } catch (error) {
    console.error("An unexpected error occurred:", error); // General error logging
  }
});

// Fetch Discord Bot Token from .env file
client.login(process.env.DISCORD_TOKEN);
