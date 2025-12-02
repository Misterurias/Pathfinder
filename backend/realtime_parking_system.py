# app.py - Fixed version with user accounts and balanced scoring
from flask import Flask, request, jsonify, render_template, session
from flask_socketio import SocketIO, emit, join_room, disconnect
import threading, time, math, random
from datetime import datetime
import uuid
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-change-in-production'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading', logger=True, engineio_logger=True)

# User database (in production, use a real database)
users_db = {}  # {username: {password_hash, preferences}}

# Enhanced garage data
parking_spots = [
    {
        "name": "Garage A",
        "address": "123 Forbes Ave",
        "lat": 40.4405,
        "lng": -79.9959,
        "price_per_hour": 3.0,
        "type": "garage",
        "total_spots": 100,
        "available_spots": 45,
        "payment_methods": ["credit_card", "app"]
    },
    {
        "name": "Garage B",
        "address": "456 Fifth Ave",
        "lat": 40.4415,
        "lng": -79.9930,
        "price_per_hour": 2.0,
        "type": "garage",
        "total_spots": 150,
        "available_spots": 80,
        "payment_methods": ["credit_card", "cash"]
    },
    {
        "name": "Garage C",
        "address": "789 Penn Ave",
        "lat": 40.4420,
        "lng": -79.9965,
        "price_per_hour": 1.5,
        "type": "garage",
        "total_spots": 75,
        "available_spots": 20,
        "payment_methods": ["credit_card", "app", "cash"]
    },
    {
        "name": "Street Parking Zone",
        "address": "Oakland District",
        "lat": 40.4430,
        "lng": -79.9940,
        "price_per_hour": 2.5,
        "type": "street",
        "total_spots": 30,
        "available_spots": 8,
        "payment_methods": ["meter", "app"]
    }
]

# Track user sessions and recommendations
user_recommendations = {}  # {session_id: {username, garage_name, timestamp, user_lat, user_lng, dest_lat, dest_lng}}
parking_lock = threading.Lock()

# Haversine distance in meters - FIXED
def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
    return R * c

def format_distance(meters):
    if meters < 1000:
        return f"{int(meters)}m"
    return f"{round(meters/1000, 1)}km"

def format_duration(seconds):
    if seconds < 60:
        return f"{int(seconds)} sec"
    elif seconds < 3600:
        return f"{int(seconds/60)} min"
    else:
        hours = int(seconds / 3600)
        mins = int((seconds % 3600) / 60)
        return f"{hours}h {mins}m"

# BALANCED SCORING: considers both driving distance AND walking distance
def score_parking(garage, user_lat, user_lng, dest_lat, dest_lng, price_weight=0.3):
    """
    Scoring that balances:
    - Distance from user to parking (driving)
    - Distance from parking to destination (walking)
    - Price
    - Availability
    """
    # Distance from user's current location to parking spot
    drive_distance = haversine(user_lat, user_lng, garage["lat"], garage["lng"])
    
    # Distance from parking to final destination (walking)
    walk_distance = haversine(garage["lat"], garage["lng"], dest_lat, dest_lng)
    
    # Total travel burden: driving + walking (walking is more painful, weight it more)
    total_distance = drive_distance + (walk_distance * 2)  # Walking counts double
    
    price = garage["price_per_hour"]
    
    # Penalize low availability
    availability_factor = 1.0 if garage["available_spots"] > 20 else 1.5
    
    # Balance distance and price
    score = ((1 - price_weight) * total_distance + price_weight * price * 100) * availability_factor
    
    return score, drive_distance, walk_distance

# Find best garage based on user's current location AND destination
def find_best_garage(user_lat, user_lng, dest_lat, dest_lng, username=None):
    best_score, best_garage, best_drive, best_walk = float('inf'), None, 0, 0
    
    # Get user preferences if logged in
    price_weight = 0.3  # default: prioritize distance over price
    if username and username in users_db:
        price_weight = users_db[username].get('price_weight', 0.3)
    
    with parking_lock:
        available_garages = [g for g in parking_spots if g["available_spots"] > 0]
        if not available_garages:
            return None, 0, 0
        
        for garage in available_garages:
            score, drive_dist, walk_dist = score_parking(
                garage, user_lat, user_lng, dest_lat, dest_lng, price_weight
            )
            if score < best_score:
                best_score = score
                best_garage = garage
                best_drive = drive_dist
                best_walk = walk_dist
    
    return best_garage, best_drive, best_walk

# Get top 3 options
def find_top_garages(user_lat, user_lng, dest_lat, dest_lng, username=None, n=3):
    price_weight = 0.3
    if username and username in users_db:
        price_weight = users_db[username].get('price_weight', 0.3)
    
    with parking_lock:
        available_garages = [g for g in parking_spots if g["available_spots"] > 0]
        if not available_garages:
            return []
        
        scored = []
        for g in available_garages:
            score, drive_dist, walk_dist = score_parking(
                g, user_lat, user_lng, dest_lat, dest_lng, price_weight
            )
            scored.append((score, g, drive_dist, walk_dist))
        
        scored.sort(key=lambda x: x[0])
        return scored[:n]

# Simulate garage occupancy changes
def simulate_spots():
    while True:
        time.sleep(8)
        
        with parking_lock:
            for garage in parking_spots:
                change = random.randint(-5, 5)
                old_available = garage["available_spots"]
                garage["available_spots"] = max(0, min(garage["total_spots"], 
                                                       garage["available_spots"] + change))
                
                if garage["available_spots"] != old_available:
                    check_user_recommendations(garage, old_available)

def check_user_recommendations(changed_garage, old_available):
    """Check if availability change affects any user's recommendation"""
    current_time = time.time()
    
    for session_id, rec in list(user_recommendations.items()):
        if current_time - rec.get("timestamp", 0) > 300:
            continue
        
        if rec["garage_name"] == changed_garage["name"]:
            if changed_garage["available_spots"] == 0:
                send_reroute_notification(session_id, rec, "full")
            elif changed_garage["available_spots"] < 5 and old_available >= 5:
                send_low_availability_warning(session_id, changed_garage)

def send_reroute_notification(session_id, old_rec, reason):
    """Send detailed reroute notification"""
    user_lat = old_rec["user_lat"]
    user_lng = old_rec["user_lng"]
    dest_lat = old_rec["dest_lat"]
    dest_lng = old_rec["dest_lng"]
    duration = old_rec.get("duration", 1)
    username = old_rec.get("username")
    
    new_garage, new_drive, new_walk = find_best_garage(user_lat, user_lng, dest_lat, dest_lng, username)
    if not new_garage:
        socketio.emit('notification', {
            "type": "error",
            "title": "⚠️ No Parking Available",
            "message": "All parking is currently full. Searching for alternatives..."
        }, room=session_id)
        return
    
    old_garage_name = old_rec["garage_name"]
    old_garage = next((g for g in parking_spots if g["name"] == old_garage_name), None)
    
    if old_garage:
        cost_diff = (new_garage["price_per_hour"] - old_garage["price_per_hour"]) * duration
        
        old_walk_dist = old_rec.get("walk_distance", 0)
        walk_diff = new_walk - old_walk_dist
        
        time_diff_min = abs(walk_diff) / 80
        
        impact_parts = []
        if abs(cost_diff) > 0.5:
            impact_parts.append(f"${abs(cost_diff):.2f} {'more' if cost_diff > 0 else 'less'}")
        
        if abs(walk_diff) > 30:
            impact_parts.append(f"{format_distance(abs(walk_diff))} {'longer' if walk_diff > 0 else 'shorter'} walk")
        
        if time_diff_min > 1:
            impact_parts.append(f"~{int(time_diff_min)} min {'more' if walk_diff > 0 else 'less'} travel time")
        
        impact_msg = " and ".join(impact_parts) if impact_parts else "minimal impact"
        
        reason_text = "is now full" if reason == "full" else "has limited availability"
        
        socketio.emit('notification', {
            "type": "reroute",
            "title": f"🔔 Rerouting Required",
            "message": f"{old_garage_name} {reason_text}. Redirecting to {new_garage['name']}.",
            "impact": f"This will affect your journey by: {impact_msg}",
            "new_garage": {
                "name": new_garage["name"],
                "address": new_garage["address"],
                "price_per_hour": new_garage["price_per_hour"],
                "estimated_cost": round(new_garage["price_per_hour"] * duration, 2),
                "available_spots": new_garage["available_spots"],
                "lat": new_garage["lat"],
                "lng": new_garage["lng"],
                "drive_distance": format_distance(new_drive),
                "walk_distance": format_distance(new_walk)
            }
        }, room=session_id)
        
        user_recommendations[session_id].update({
            "garage_name": new_garage["name"],
            "timestamp": time.time(),
            "walk_distance": new_walk
        })

def send_low_availability_warning(session_id, garage):
    """Warn user their garage is filling up"""
    socketio.emit('notification', {
        "type": "warning",
        "title": "⚠️ Filling Up Fast",
        "message": f"{garage['name']} only has {garage['available_spots']} spots left. You may want to hurry or consider alternatives.",
        "garage": garage["name"],
        "spots_remaining": garage["available_spots"]
    }, room=session_id)

# USER AUTHENTICATION
@app.route('/api/register', methods=['POST'])
def register():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    
    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400
    
    if username in users_db:
        return jsonify({"error": "Username already exists"}), 400
    
    users_db[username] = {
        "password_hash": generate_password_hash(password),
        "price_weight": 0.3,  # default: balance distance and price
        "created_at": datetime.now().isoformat()
    }
    
    return jsonify({"message": "User registered successfully", "username": username}), 201

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('username')
    password = data.get('password')
    
    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400
    
    if username not in users_db:
        return jsonify({"error": "Invalid credentials"}), 401
    
    if not check_password_hash(users_db[username]["password_hash"], password):
        return jsonify({"error": "Invalid credentials"}), 401
    
    session['username'] = username
    return jsonify({"message": "Login successful", "username": username}), 200

@app.route('/api/logout', methods=['POST'])
def logout():
    session.pop('username', None)
    return jsonify({"message": "Logged out successfully"}), 200

@app.route('/api/preferences', methods=['GET', 'POST'])
def preferences():
    username = session.get('username')
    if not username:
        return jsonify({"error": "Not logged in"}), 401
    
    if request.method == 'POST':
        data = request.json
        price_weight = data.get('price_weight', 0.3)
        users_db[username]['price_weight'] = max(0, min(1, price_weight))
        return jsonify({"message": "Preferences updated"}), 200
    
    return jsonify({
        "price_weight": users_db[username].get('price_weight', 0.3)
    }), 200

# WebSocket handlers
@socketio.on('connect')
def handle_connect():
    session_id = request.sid
    join_room(session_id)
    username = session.get('username', 'guest')
    print(f"User connected: {session_id} (username: {username})")
    emit('connected', {"session_id": session_id, "username": username})

@socketio.on('disconnect')
def handle_disconnect():
    session_id = request.sid
    if session_id in user_recommendations:
        del user_recommendations[session_id]
    print(f"User disconnected: {session_id}")

@socketio.on('request_parking')
def handle_parking_request(data):
    session_id = request.sid
    username = session.get('username')
    
    try:
        user_lat = float(data.get("user_lat"))
        user_lng = float(data.get("user_lng"))
        dest_lat = float(data.get("dest_lat"))
        dest_lng = float(data.get("dest_lng"))
        duration = float(data.get("duration", 1))
    except (TypeError, ValueError):
        emit('notification', {
            "type": "error",
            "message": "Invalid location data"
        })
        return
    
    best_garage, best_drive, best_walk = find_best_garage(user_lat, user_lng, dest_lat, dest_lng, username)
    if not best_garage:
        emit('notification', {
            "type": "error",
            "message": "No parking available"
        })
        return
    
    # Get alternatives
    top_garages = find_top_garages(user_lat, user_lng, dest_lat, dest_lng, username, n=3)
    alternatives = []
    
    cost_best = best_garage["price_per_hour"] * duration
    
    for score, alt, drive_dist, walk_dist in top_garages[1:]:
        cost_alt = alt["price_per_hour"] * duration
        cost_diff = cost_alt - cost_best
        walk_diff = walk_dist - best_walk
        
        reason_parts = []
        if abs(cost_diff) > 0.5:
            reason_parts.append(f"{'saves' if cost_diff < 0 else 'costs'} ${abs(cost_diff):.2f}")
        if abs(walk_diff) > 50:
            reason_parts.append(f"{format_distance(abs(walk_diff))} {'shorter' if walk_diff < 0 else 'longer'} walk")
        
        alternatives.append({
            "name": alt["name"],
            "address": alt["address"],
            "price_per_hour": alt["price_per_hour"],
            "estimated_cost": round(cost_alt, 2),
            "available_spots": alt["available_spots"],
            "drive_distance": format_distance(drive_dist),
            "walk_distance": format_distance(walk_dist),
            "reason": ", ".join(reason_parts) if reason_parts else "similar option"
        })
    
    # Store recommendation
    user_recommendations[session_id] = {
        "username": username,
        "garage_name": best_garage["name"],
        "timestamp": time.time(),
        "user_lat": user_lat,
        "user_lng": user_lng,
        "dest_lat": dest_lat,
        "dest_lng": dest_lng,
        "duration": duration,
        "walk_distance": best_walk
    }
    
    # Send recommendation
    emit('parking_recommendation', {
        "best_parking": {
            "name": best_garage["name"],
            "address": best_garage["address"],
            "type": best_garage["type"],
            "lat": best_garage["lat"],
            "lng": best_garage["lng"],
            "price_per_hour": best_garage["price_per_hour"],
            "estimated_cost": round(best_garage["price_per_hour"] * duration, 2),
            "available_spots": best_garage["available_spots"],
            "total_spots": best_garage["total_spots"],
            "payment_methods": best_garage["payment_methods"],
            "drive_distance": format_distance(best_drive),
            "walk_distance": format_distance(best_walk)
        },
        "alternatives": alternatives,
        "timestamp": datetime.now().isoformat()
    })

@app.route("/")
def index():
    return render_template("index.html")

if __name__ == "__main__":
    # Create a test user
    users_db['testuser'] = {
        "password_hash": generate_password_hash('password123'),
        "price_weight": 0.3
    }
    
    threading.Thread(target=simulate_spots, daemon=True).start()
    socketio.run(app, debug=True, host='0.0.0.0', port=5050)