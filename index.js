const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const cors = require("cors")
const admin = require("firebase-admin")
// const serviceAccount = require("./serviceAccountKey.json") 

require('dotenv').config();

const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})



const db = admin.firestore()
const app = express()
app.use(cors())
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
})

// Game constants
const ROUND_DURATION = 60 // seconds
const BETTING_PHASE_DURATION = 30 // seconds

// Game state
let currentRound = null
let roundStartTime = null
let roundEndTime = null
let timeLeft = ROUND_DURATION
let roundInterval = null

// Function to get current round from Firebase
async function getCurrentRoundFromFirebase() {
  try {
    const roundsRef = db.collection("rounds")
    const snapshot = await roundsRef.orderBy("startTime", "desc").limit(1).get()

    if (snapshot.empty) {
      console.log("No rounds found in Firebase")
      return null
    }

    const roundDoc = snapshot.docs[0]
    const roundData = roundDoc.data()

    return {
      id: roundDoc.id,
      ...roundData,
      startTime: roundData.startTime.toDate(),
      endTime: new Date(roundData.startTime.toDate().getTime() + ROUND_DURATION * 1000),
    }
  } catch (error) {
    console.error("Error getting current round from Firebase:", error)
    return null
  }
}

// Function to create a new round in Firebase
async function createNewRoundInFirebase() {
  try {
    const now = new Date()
    const roundData = {
      startTime: admin.firestore.Timestamp.fromDate(now),
      totalBuyAmount: 0,
      totalSellAmount: 0,
      totalBets: 0,
      result: null,
      status: "active",
    }

    const docRef = await db.collection("rounds").add(roundData)
    console.log("New round created in Firebase with ID:", docRef.id)

    return {
      id: docRef.id,
      ...roundData,
      startTime: now,
      endTime: new Date(now.getTime() + ROUND_DURATION * 1000),
    }
  } catch (error) {
    console.error("Error creating new round in Firebase:", error)
    throw error
  }
}

// Function to finalize a round in Firebase
async function finalizeRoundInFirebase(roundId) {
  try {
    const roundRef = db.collection("rounds").doc(roundId)
    const roundDoc = await roundRef.get()

    if (!roundDoc.exists) {
      console.error("Round not found:", roundId)
      return null
    }

    const roundData = roundDoc.data()

    // If result is already set, return the round
    if (roundData.result) {
      return {
        id: roundId,
        ...roundData,
        startTime: roundData.startTime.toDate(),
        endTime: new Date(roundData.startTime.toDate().getTime() + ROUND_DURATION * 1000),
      }
    }

    // Determine result (similar to your existing logic)
    let result
    const randomFactor = Math.random()
    const buyRatio = roundData.totalBuyAmount / (roundData.totalBuyAmount + roundData.totalSellAmount || 1)

    if (randomFactor < 0.5) {
      result = buyRatio >= 0.5 ? "sell" : "buy"
    } else {
      result = buyRatio >= 0.5 ? "buy" : "sell"
    }

    // Update the round with the result
    await roundRef.update({
      result,
      status: "completed",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    console.log(`Round ${roundId} finalized with result: ${result}`)

    // Process bets
    await processBetsInFirebase(roundId, result)

    return {
      id: roundId,
      ...roundData,
      result,
      status: "completed",
      startTime: roundData.startTime.toDate(),
      endTime: new Date(roundData.startTime.toDate().getTime() + ROUND_DURATION * 1000),
    }
  } catch (error) {
    console.error("Error finalizing round in Firebase:", error)
    return null
  }
}

// Function to process bets in Firebase
async function processBetsInFirebase(roundId, result) {
  try {
    const betsRef = db.collection("bets")
    const querySnapshot = await betsRef.where("roundId", "==", roundId).where("processed", "==", false).get()

    console.log(`Processing ${querySnapshot.size} bets for round ${roundId}`)

    const batch = db.batch()
    const promises = []

    querySnapshot.forEach((betDoc) => {
      const betData = betDoc.data()
      const betResult = betData.bet === result ? "win" : "lose"
      const betRef = db.collection("bets").doc(betDoc.id)

      // Update bet with result
      batch.update(betRef, {
        result: betResult,
        roundResult: result,
        processed: true,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      })

      // If the bet is a win, update user balance
      if (betResult === "win") {
        const winAmount = betData.amount * 1.9 // RESULT_MULTIPLIER
        const userRef = db.collection("users").doc(betData.userId)

        promises.push(
          userRef.update({
            balance: admin.firestore.FieldValue.increment(winAmount),
          }),
        )

        // Add transaction record for the win
        promises.push(
          db.collection("transactions").add({
            userId: betData.userId,
            type: "win",
            amount: winAmount,
            roundId,
            bet: betData.bet,
            result,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          }),
        )
      } else {
        // Add transaction record for the loss
        promises.push(
          db.collection("transactions").add({
            userId: betData.userId,
            type: "loss",
            amount: betData.amount,
            roundId,
            bet: betData.bet,
            result,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          }),
        )
      }
    })

    // Commit the batch
    await batch.commit()

    // Execute all promises
    if (promises.length > 0) {
      await Promise.all(promises)
      console.log(`Processed ${promises.length} updates for round ${roundId}`)
    }
  } catch (error) {
    console.error("Error processing bets in Firebase:", error)
  }
}

// Initialize game
async function initializeGame() {
  try {
    // Get current round from Firebase
    currentRound = await getCurrentRoundFromFirebase()

    // If no round exists or the current round is completed, create a new one
    if (!currentRound || currentRound.result) {
      currentRound = await createNewRoundInFirebase()
    }

    roundStartTime = currentRound.startTime
    roundEndTime = currentRound.endTime

    // Calculate time left
    const now = new Date()
    timeLeft = Math.max(0, Math.floor((roundEndTime - now) / 1000))

    console.log("Game initialized with round:", currentRound.id)
    console.log("Time left:", timeLeft)

    // Start the round timer
    startRoundTimer()
  } catch (error) {
    console.error("Error initializing game:", error)
  }
}

// Start round timer
function startRoundTimer() {
  // Clear any existing interval
  if (roundInterval) {
    clearInterval(roundInterval)
  }

  console.log(`Starting round timer for round ${currentRound.id}, time left: ${timeLeft}s`)

  // Update time left every second
  roundInterval = setInterval(async () => {
    const now = new Date()
    timeLeft = Math.max(0, Math.floor((roundEndTime - now) / 1000))

    // Emit time update to all clients
    io.emit("timeUpdate", {
      roundId: currentRound.id,
      timeLeft,
      bettingPhase: timeLeft > ROUND_DURATION - BETTING_PHASE_DURATION ? "betting" : "waiting",
    })

    // If round has ended, finalize it and start a new one
    if (timeLeft === 0) {
      // Clear the interval to prevent multiple finalizations
      clearInterval(roundInterval)
      roundInterval = null

      console.log("Round ended:", currentRound.id)

      try {
        // Finalize the current round
        await finalizeRoundInFirebase(currentRound.id)

        // Create a new round
        currentRound = await createNewRoundInFirebase()
        roundStartTime = currentRound.startTime
        roundEndTime = currentRound.endTime
        timeLeft = ROUND_DURATION

        console.log("New round started:", currentRound.id)

        // Emit round change event
        const roundChangeData = {
          roundId: currentRound.id,
          startTime: roundStartTime,
          endTime: roundEndTime,
          timeLeft,
        }
        console.log("Emitting round change:", roundChangeData)
        io.emit("roundChange", roundChangeData)

        // Restart the timer
        startRoundTimer()
      } catch (error) {
        console.error("Error handling round end:", error)

        // Try to recover by initializing the game again after a short delay
        console.log("Attempting recovery in 5 seconds...")
        setTimeout(() => {
          initializeGame()
        }, 5000)
      }
    }
  }, 1000)
}

// Socket.io connection handler
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id)

  // Send current game state to the client
  const gameState = {
    roundId: currentRound?.id,
    startTime: roundStartTime,
    endTime: roundEndTime,
    timeLeft,
    bettingPhase: timeLeft > ROUND_DURATION - BETTING_PHASE_DURATION ? "betting" : "waiting",
  }

  console.log(`Sending initial game state to client ${socket.id}:`, gameState)
  socket.emit("gameState", gameState)

  // Handle explicit requests for game state
  socket.on("getGameState", () => {
    const currentState = {
      roundId: currentRound?.id,
      startTime: roundStartTime,
      endTime: roundEndTime,
      timeLeft,
      bettingPhase: timeLeft > ROUND_DURATION - BETTING_PHASE_DURATION ? "betting" : "waiting",
    }
    console.log(`Client ${socket.id} requested game state:`, currentState)
    socket.emit("gameState", currentState)
  })

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id)
  })
})

// API endpoints
app.get("/api/game-state", (req, res) => {
  res.json({
    roundId: currentRound?.id,
    startTime: roundStartTime,
    endTime: roundEndTime,
    timeLeft,
    bettingPhase: timeLeft > ROUND_DURATION - BETTING_PHASE_DURATION ? "betting" : "waiting",
  })
})

// Start the server
const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  initializeGame()
})
