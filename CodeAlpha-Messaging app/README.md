# GupShup - Mini Social Media App

Frontend: HTML + CSS + vanilla JavaScript
Backend: Express.js (REST API, JWT auth)
Database: SQLite (file `social.db`, created automatically)

## Run
```bash
npm install
npm start
```
Open http://localhost:3000, create two accounts (use two browsers or one normal + one incognito window) and try follow / like / comment.

Optional: `JWT_SECRET=your-secret PORT=4000 npm start`

## Features
- Register / login (bcrypt password hashing, JWT token)
- User profiles: display name, bio, post/follower/following counts, edit your own profile
- Posts (max 280 chars), delete your own posts
- Comments (max 200 chars), delete your own comments
- Like / unlike posts
- Follow / unfollow users, "Following" feed tab, "Who to follow" suggestions

## Database tables
users(id, username, password_hash, display_name, bio, created_at)
posts(id, user_id, content, created_at)
comments(id, post_id, user_id, content, created_at)
likes(user_id, post_id)            - composite primary key
follows(follower_id, following_id) - composite primary key

## API
POST   /api/auth/register          POST   /api/auth/login        GET /api/me
GET    /api/feed?scope=all|following
POST   /api/posts                  DELETE /api/posts/:id
POST   /api/posts/:id/like         (toggle)
GET    /api/posts/:id/comments     POST   /api/posts/:id/comments   DELETE /api/comments/:id
GET    /api/users/suggestions      GET    /api/users/:username      PUT /api/users/me
POST   /api/users/:username/follow (toggle)
