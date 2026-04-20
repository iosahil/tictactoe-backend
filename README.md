# TicTacToe Multiplayer

## Screenshots
<p align="center">
    <a href="https://github.com/user-attachments/assets/bfd6b505-ed2f-4322-b3f8-357ddce25dd7"><img width="220" alt="Screenshot 1" src="https://github.com/user-attachments/assets/bfd6b505-ed2f-4322-b3f8-357ddce25dd7" /></a>
    <a href="https://github.com/user-attachments/assets/8ae710ff-d582-4b2d-b96d-63a632927adf"><img width="220" alt="Screenshot 2" src="https://github.com/user-attachments/assets/8ae710ff-d582-4b2d-b96d-63a632927adf" /></a>
    <a href="https://github.com/user-attachments/assets/fb937bc5-300e-4c81-a61a-12e285a4a35d"><img width="220" alt="Screenshot 3" src="https://github.com/user-attachments/assets/fb937bc5-300e-4c81-a61a-12e285a4a35d" /></a>
    <a href="https://github.com/user-attachments/assets/7511cb40-5920-45f4-9fe3-6730b2f583e2"><img width="220" alt="Screenshot 4" src="https://github.com/user-attachments/assets/7511cb40-5920-45f4-9fe3-6730b2f583e2" /></a>
    <a href="https://github.com/user-attachments/assets/f747a598-55db-460b-8ff6-03206d48915d"><img width="220" alt="Screenshot 5" src="https://github.com/user-attachments/assets/f747a598-55db-460b-8ff6-03206d48915d" /></a>
    <a href="https://github.com/user-attachments/assets/555fc40e-8158-4eeb-aad9-8524a2ecb175"><img width="220" alt="Screenshot 6" src="https://github.com/user-attachments/assets/555fc40e-8158-4eeb-aad9-8524a2ecb175" /></a>
    <a href="https://github.com/user-attachments/assets/52e6f0e7-3846-4ed5-9ec9-088e69c70ea4"><img width="220" alt="Screenshot 7" src="https://github.com/user-attachments/assets/52e6f0e7-3846-4ed5-9ec9-088e69c70ea4" /></a>
    <a href="https://github.com/user-attachments/assets/ca3cd8cc-754c-491d-810d-a43c8a149d41"><img width="220" alt="Screenshot 8" src="https://github.com/user-attachments/assets/ca3cd8cc-754c-491d-810d-a43c8a149d41" /></a>
</p>

## Deliverables
- Android app source code repository: [iosahil/TicTacToe](https://github.com/iosahil/TicTacToe)
- Nakama backend source code repository: [iosahil/tictactoe-backend](https://github.com/iosahil/tictactoe-backend)
- Deployed and accessible game mobile application: [TicTacToe-v1.0.0.apk](https://github.com/iosahil/TicTacToe/releases/download/v1.0.0/TicTacToe-v1.0.0.apk)
- Deployed Nakama server endpoint: [tictactoedemo-console.nicemeadow-f4d6a9ec.centralindia.azurecontainerapps.io](https://tictactoedemo-console.nicemeadow-f4d6a9ec.centralindia.azurecontainerapps.io/)

## Project Layout
| Project        | Repository                                         | Purpose                                                 |
|----------------|----------------------------------------------------|---------------------------------------------------------|
| Android app    | [iosahil/TicTacToe](https://github.com/iosahil/TicTacToe) | UI, navigation, auth, realtime gameplay client          |
| Nakama backend | [iosahil/tictactoe-backend](https://github.com/iosahil/tictactoe-backend) | Matchmaking, room flow, game loop, leaderboard, history |

## Setup and Installation
<details>
<summary><strong>Open setup steps</strong></summary>

### 1) Clone repositories (required first step)
```bash
git clone https://github.com/iosahil/tictactoe-backend.git
git clone https://github.com/iosahil/TicTacToe.git
```

### 2) Nakama backend setup
1. In the backend repository root, copy `.env.example` to `.env` & fill it with values.
2. Build backend runtime module:
   ```bash
   cd server
   npm install
   npm run build
   ```

### 3) Android setup (`gradle.properties` is mandatory)
Update the Android project's root `gradle.properties` with these required keys:

```properties
nakama.host=<nakama-api-host>
nakama.port=<nakama-api-port>
nakama.serverKey=<must-match-NAKAMA_SERVER_KEY>
nakama.ssl=<true-or-false>
nakama.socketHost=<nakama-socket-host>
nakama.socketPort=<nakama-socket-port>
nakama.socketSsl=<true-or-false>
nakama.certPin=<sha256/certificate-pin>
google.webClientId=<google-oauth-web-client-id>
```

Then build the Android app:

```bash
cd TicTacToe
./gradlew.bat :app:assembleDebug
```

</details>

## Architecture and Design
### High-level
- Frontend: MVVM + unidirectional state
- Backend: server-authoritative match logic
- Integration: REST for auth/RPC + WebSocket for realtime match events

### User flow
```mermaid
flowchart TD
    A[Player opens Hub] --> B{Select game type}

    B -->|Ranked| C[Choose mode and enter queue]
    C --> D[Matchmaker pairs two compatible players]
    D --> E[Both players enter one authoritative match]

    B -->|Room| F[Host creates room or player joins by room code]
    F --> E

    E --> G[Lobby sync: players and mode]
    G --> H[Host starts game]
    H --> I[Turn-based play with server-side move validation]
    I --> J[Final result broadcast to both players]

    J --> K{Game type}
    K -->|Ranked| L[Leaderboard updated + match history saved]
    K -->|Room| M[Match history saved, leaderboard unchanged]
```

### Network calls
```mermaid
sequenceDiagram
    autonumber
    participant App as Android App
    participant Rest as Nakama REST (HTTP)
    participant Sock as Nakama Socket (WSS)
    participant Runtime as Match Runtime

    Note over App,Rest: App startup and auth
    App->>Rest: Authenticate / restore session
    Rest-->>App: JWT + refresh token
    App->>Sock: Open realtime socket with JWT
    Sock-->>App: Connected + presence ready

    alt Ranked flow
        App->>Sock: addMatchmaker(mode)
        Sock-->>App: onMatchmakerMatched(matchId)
    else Room flow
        App->>Rest: RPC create_room or join_room
        Rest-->>App: roomCode + matchId
    end

    App->>Sock: joinMatch(matchId)
    Sock-->>App: OP_ROOM_STATE / OP_STATE

    loop During gameplay turns
        App->>Sock: OP_MOVE
        Runtime-->>Sock: validate move + update board
        Sock-->>App: OP_STATE
    end

    Runtime-->>Sock: OP_GAME_OVER
    Sock-->>App: OP_GAME_OVER
    Runtime->>Runtime: Ranked only -> increment leaderboard
    Runtime->>Runtime: Persist match history for both players
```

## Decisions Taken
- Server authoritative board/turn/winner: prevents client-side cheating
- Ranked and room use same match loop
- Leaderboard update only on ranked games
- Match history for both players on game end
- Host-only controls in room (start + mode update)
- Host-return timeout in room flow to auto-clean stale rooms
- Session restore + refresh fallback in app
- Connection probe status exposed to UI for clear offline handling
- Production traffic is HTTPS/WSS only, with certificate pinning on Nakama hosts and cleartext blocked for production domains

## Deployment Process Documentation
### Initial deployment
Use the main deploy script from the `deploy` folder.

Recommended flow (reads required values from `.env`):
- `cd deploy`
- `./deploy.ps1`

Or pass explicit parameters:
- `./deploy.ps1 -ResourceGroup <rg> -Location <region> -ContainerApp <app> -ContainerAppEnv <env> -AcrName <acr> -AcrLoginServer <acr>.azurecr.io -DbAddress "<user>:<pass>@<host>:5432/nakama?sslmode=require" -NakamaServerKey "<key>"`

### Refresh existing deployment
Use refresh script for update-only flow:
- `./refresh.ps1 -ResourceGroup <rg> -ContainerApp <app> -AcrName <acr> -AcrLoginServer <acr>.azurecr.io`

### Nakama runtime config
- File: `nakama-config.yml`
- JS entrypoint: `build/main.js`
- Server key: `socket.server_key`
- Matchmaker tuning: interval/max intervals/max tickets

## How to Test Multiplayer Functionality
### Prerequisites
- Two logged-in devices

### Ranked test
1. Start ranked queue with same mode
2. Confirm transition: `Hub -> Matchmaking -> Game`
3. Play match
4. Confirm leaderboard increments
5. Check match history updates for both users

### Room test
1. Host creates room
2. Guest joins using room code
3. Host changes mode and starts match
4. Play full match
5. Return to room lobby
6. Host leaves room and verify room closes for guest
7. Check no ranked leaderboard increment from room game


## NOTE
1. I initially integrated the official Nakama Java SDK (`nakama-java`).
During implementation, SDK-level issues slowed delivery, so I switched to a direct REST + WebSocket client integration.
This provided predictable control over authentication, RPC calls, and realtime op-code handling while keeping gameplay server-authoritative.
2. I chose native Android development with Kotlin instead of cross-platform frameworks to optimize performance and align with my strongest development experience.
3. I implemented Google Sign-In instead of name-based authentication to provide stronger identity guarantees and better long-term scalability.
4. The app UX is intentionally designed to feel replayable and social, so it plays like a real product rather than a tutorial-style TicTacToe demo.
