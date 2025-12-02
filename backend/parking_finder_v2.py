import math
import time
import threading
import requests
from flask import Flask, request, jsonify
from datetime import datetime
from flask_cors import CORS

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})


@app.route("/")
def index():
    return jsonify({"message": "This is the api!"})


# Enhanced parking spots with capacity (general garages, not specific spots)
parking_spots = [
    {
        "name": "Garage A",
        "address": "123 Forbes Ave",
        "lat": 40.4405,
        "lng": -79.9959,
        "price_per_hour": 3.0,
        "capacity": 100,
        "available_spots": 45,
        "type": "garage",
        "payment_methods": ["credit_card", "app"],
        "hours": "24/7"
    },
    {
        "name": "Garage B",
        "address": "456 Fifth Ave",
        "lat": 40.4415,
        "lng": -79.9930,
        "price_per_hour": 2.0,
        "capacity": 150,
        "available_spots": 80,
        "type": "garage",
        "payment_methods": ["credit_card", "cash"],
        "hours": "6am-12am"
    },
    {
        "name": "Garage C",
        "address": "789 Penn Ave",
        "lat": 40.4420,
        "lng": -79.9965,
        "price_per_hour": 1.5,
        "capacity": 75,
        "available_spots": 20,
        "type": "garage",
        "payment_methods": ["credit_card", "app", "cash"],
        "hours": "24/7"
    },
    {
        "name": "Street Parking Zone",
        "address": "Oakland District",
        "lat": 40.4430,
        "lng": -79.9940,
        "price_per_hour": 2.5,
        "capacity": 30,
        "available_spots": 5,
        "type": "street",
        "payment_methods": ["meter", "app"],
        "hours": "8am-8pm (free after)"
    },
]

GOOGLE_MAPS_API_KEY = "YOUR_GOOGLE_MAPS_API_KEY"  # replace with your key
parking_lock = threading.Lock()

# Haversine distance in meters
def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

# Weighted scoring: distance vs price
def score_parking(parking, dest_lat, dest_lng, alpha=0.5):
    distance = haversine(parking["lat"], parking["lng"], dest_lat, dest_lng)
    price = parking["price_per_hour"]
    # Penalize low availability
    availability_factor = 1.0 if parking["available_spots"] > 20 else 1.5
    return (alpha * distance + (1 - alpha) * price * 100) * availability_factor

def find_top_parking(dest_lat, dest_lng, n=3):
    with parking_lock:
        available_spots = [p for p in parking_spots if p["available_spots"] > 0]
    if not available_spots:
        return []
    scored = [(score_parking(p, dest_lat, dest_lng), p) for p in available_spots]
    scored.sort(key=lambda x: x[0])
    return [(p, s) for s, p in scored[:n]]

def get_directions(origin_lat, origin_lng, dest_lat, dest_lng, mode="driving"):
    url = f"https://maps.googleapis.com/maps/api/directions/json?origin={origin_lat},{origin_lng}&destination={dest_lat},{dest_lng}&mode={mode}&key={GOOGLE_MAPS_API_KEY}"
    try:
        response = requests.get(url, timeout=5)
        if response.status_code != 200:
            return None, None, None
        data = response.json()
        if data['status'] != 'OK':
            return None, None, None
        
        steps = []
        duration = 0
        distance = 0
        
        for leg in data['routes'][0]['legs']:
            duration += leg['duration']['value']  # seconds
            distance += leg['distance']['value']  # meters
            for step in leg['steps']:
                instruction = step['html_instructions'].replace('<b>', '').replace('</b>', '').replace('<div style="font-size:0.9em">', ' ').replace('</div>', '')
                steps.append(instruction)
        
        return steps, duration, distance
    except Exception as e:
        print(f"Direction API error: {e}")
        return None, None, None

def format_duration(seconds):
    if seconds < 60:
        return f"{int(seconds)} sec"
    elif seconds < 3600:
        return f"{int(seconds/60)} min"
    else:
        hours = int(seconds / 3600)
        mins = int((seconds % 3600) / 60)
        return f"{hours}h {mins}m"

def format_distance(meters):
    if meters < 1000:
        return f"{int(meters)}m"
    else:
        return f"{round(meters/1000, 1)}km"

# API endpoint to get best parking + directions
@app.route("/current_parking", methods=["GET"])
def current_parking():
    try:
        user_lat = float(request.args.get("user_lat"))
        user_lng = float(request.args.get("user_lng"))
        dest_lat = float(request.args.get("dest_lat"))
        dest_lng = float(request.args.get("dest_lng"))
        duration = float(request.args.get("duration", 1))
    except:
        return jsonify({"error": "Missing or invalid parameters"}), 400

    top_spots = find_top_parking(dest_lat, dest_lng, n=3)
    if not top_spots:
        return jsonify({"error": "No parking available"}), 404

    best, score = top_spots[0]
    
    # Get driving directions to parking
    drive_directions, drive_time, drive_distance = get_directions(
        user_lat, user_lng, best["lat"], best["lng"], mode="driving"
    )
    
    # Get walking directions from parking to destination
    walk_directions, walk_time, walk_distance = get_directions(
        best["lat"], best["lng"], dest_lat, dest_lng, mode="walking"
    )
    
    # Fallback if API fails
    if drive_directions is None:
        drive_distance = haversine(user_lat, user_lng, best["lat"], best["lng"])
        drive_directions = [f"Drive approximately {format_distance(drive_distance)} to {best['name']}"]
        drive_time = None
    
    if walk_directions is None:
        walk_distance = haversine(best["lat"], best["lng"], dest_lat, dest_lng)
        walk_directions = [f"Walk approximately {format_distance(walk_distance)} to destination"]
        walk_time = None
    
    total_cost = round(best["price_per_hour"] * duration, 2)
    
    # Build alternatives list
    alternatives = []
    for alt, alt_score in top_spots[1:]:
        cost_diff = round((alt["price_per_hour"] - best["price_per_hour"]) * duration, 2)
        walk_dist_diff = int(haversine(alt["lat"], alt["lng"], dest_lat, dest_lng) - walk_distance)
        
        reason = []
        if cost_diff < 0:
            reason.append(f"saves ${abs(cost_diff)}")
        elif cost_diff > 0:
            reason.append(f"costs ${cost_diff} more")
        
        if walk_dist_diff > 50:
            reason.append(f"{format_distance(abs(walk_dist_diff))} longer walk")
        elif walk_dist_diff < -50:
            reason.append(f"{format_distance(abs(walk_dist_diff))} shorter walk")
        
        alternatives.append({
            "name": alt["name"],
            "address": alt["address"],
            "price_per_hour": alt["price_per_hour"],
            "estimated_cost": round(alt["price_per_hour"] * duration, 2),
            "available_spots": alt["available_spots"],
            "walk_distance": format_distance(haversine(alt["lat"], alt["lng"], dest_lat, dest_lng)),
            "reason": ", ".join(reason) if reason else "similar option"
        })
    
    return jsonify({
        "best_parking": {
            "name": best["name"],
            "address": best["address"],
            "type": best["type"],
            "lat": best["lat"],
            "lng": best["lng"],
            "price_per_hour": best["price_per_hour"],
            "estimated_cost": total_cost,
            "available_spots": best["available_spots"],
            "capacity": best["capacity"],
            "payment_methods": best["payment_methods"],
            "hours": best["hours"]
        },
        "directions_to_parking": {
            "steps": drive_directions[:10],  # limit to 10 steps
            "duration": format_duration(drive_time) if drive_time else "Unknown",
            "distance": format_distance(drive_distance) if drive_distance else "Unknown"
        },
        "walk_to_destination": {
            "steps": walk_directions[:10],
            "duration": format_duration(walk_time) if walk_time else "Unknown",
            "distance": format_distance(walk_distance),
            "warning": "Long walk ahead" if walk_distance > 500 else None
        },
        "alternatives": alternatives,
        "score": round(score, 2),
        "timestamp": datetime.now().isoformat()
    })

# --- Simulate dynamic parking availability ---
def simulate_parking_changes():
    import random
    while True:
        time.sleep(15)
        with parking_lock:
            spot = random.choice(parking_spots)
            change = random.randint(-10, 10)
            spot["available_spots"] = max(0, min(spot["capacity"], spot["available_spots"] + change))
            print(f"[{datetime.now().strftime('%H:%M:%S')}] {spot['name']}: {spot['available_spots']}/{spot['capacity']} spots")

# --- Simulate user navigation with smart notifications ---
def simulate_user_navigation(user_lat, user_lng, dest_lat, dest_lng, duration=1):
    last_recommended = None
    last_notification_time = time.time()
    lat, lng = user_lat, user_lng
    
    print(f"\n{'='*60}")
    print(f"🚗 Starting navigation from ({lat}, {lng}) to ({dest_lat}, {dest_lng})")
    print(f"{'='*60}\n")
    
    while haversine(lat, lng, dest_lat, dest_lng) > 5:
        top_spots = find_top_parking(dest_lat, dest_lng, n=3)
        
        if not top_spots:
            print("⚠️ ALERT: No parking available anywhere!")
            time.sleep(5)
            continue
        
        best, score = top_spots[0]
        current_time = time.time()
        
        # Check if we need to reroute
        if last_recommended is not None and best["name"] != last_recommended["name"]:
            # Calculate impact of change
            old_spot = last_recommended
            
            # Check if old spot still has availability
            with parking_lock:
                old_still_available = any(
                    p["name"] == old_spot["name"] and p["available_spots"] > 0 
                    for p in parking_spots
                )
            
            distance_to_current = haversine(lat, lng, best["lat"], best["lng"])
            
            # Only notify if: spot became unavailable OR significantly better option AND not too close to old spot
            should_notify = False
            reason = ""
            
            if not old_still_available:
                should_notify = True
                reason = f"❌ {old_spot['name']} is now full"
            elif distance_to_current > 200:  # More than 200m away, consider switching
                old_cost = old_spot["price_per_hour"] * duration
                new_cost = best["price_per_hour"] * duration
                cost_savings = old_cost - new_cost
                
                if cost_savings > 1.0:  # Save more than $1
                    should_notify = True
                    reason = f"💰 Better deal available (save ${round(cost_savings, 2)})"
            
            if should_notify and (current_time - last_notification_time) > 10:  # Throttle notifications
                # Calculate impact
                old_walk_dist = haversine(old_spot["lat"], old_spot["lng"], dest_lat, dest_lng)
                new_walk_dist = haversine(best["lat"], best["lng"], dest_lat, dest_lng)
                walk_diff = new_walk_dist - old_walk_dist
                
                cost_diff = (best["price_per_hour"] - old_spot["price_per_hour"]) * duration
                
                # Get rough time estimate
                _, drive_time, _ = get_directions(lat, lng, best["lat"], best["lng"], mode="driving")
                _, walk_time, _ = get_directions(best["lat"], best["lng"], dest_lat, dest_lng, mode="walking")
                
                print(f"\n{'─'*60}")
                print(f"🔔 REROUTE NOTIFICATION")
                print(f"{'─'*60}")
                print(f"Reason: {reason}")
                print(f"\n📍 New recommendation: {best['name']}")
                print(f"   Address: {best['address']}")
                print(f"   Available spots: {best['available_spots']}/{best['capacity']}")
                print(f"\n📊 Impact on your journey:")
                
                if cost_diff != 0:
                    impact = f"{'saves' if cost_diff < 0 else 'adds'} ${abs(round(cost_diff, 2))}"
                    print(f"   Cost: {impact}")
                else:
                    print(f"   Cost: same (${round(best['price_per_hour'] * duration, 2)})")
                
                if abs(walk_diff) > 20:
                    walk_impact = f"{'shorter' if walk_diff < 0 else 'longer'} walk ({format_distance(abs(walk_diff))})"
                    print(f"   Walk: {walk_impact}")
                else:
                    print(f"   Walk: similar distance")
                
                if drive_time and walk_time:
                    total_time = format_duration(drive_time + walk_time)
                    print(f"   Total time to destination: ~{total_time}")
                
                print(f"\n🗺️  First steps:")
                directions, _, _ = get_directions(lat, lng, best["lat"], best["lng"], mode="driving")
                if directions:
                    for step in directions[:3]:
                        print(f"   • {step}")
                
                print(f"{'─'*60}\n")
                
                last_notification_time = current_time
        
        elif last_recommended is None:
            # First recommendation
            print(f"\n📍 Initial recommendation: {best['name']}")
            print(f"   Cost: ${round(best['price_per_hour'] * duration, 2)} for {duration}h")
            print(f"   Available spots: {best['available_spots']}/{best['capacity']}")
            
            directions, drive_time, _ = get_directions(lat, lng, best["lat"], best["lng"], mode="driving")
            walk_directions, walk_time, walk_dist = get_directions(best["lat"], best["lng"], dest_lat, dest_lng, mode="walking")
            
            if drive_time and walk_time:
                print(f"   Drive time: {format_duration(drive_time)}")
                print(f"   Walk to destination: {format_duration(walk_time)} ({format_distance(walk_dist)})")
            print()
        
        last_recommended = best.copy()
        
        # Move user closer to destination
        lat += (dest_lat - lat) * 0.08
        lng += (dest_lng - lng) * 0.08
        time.sleep(5)
    
    print(f"\n{'='*60}")
    print(f"✅ Arrived near destination!")
    print(f"🅿️  Recommended parking: {last_recommended['name']}")
    print(f"{'='*60}\n")

if __name__ == "__main__":
    threading.Thread(target=simulate_parking_changes, daemon=True).start()
    
    # Example: simulate user navigating
    threading.Thread(
        target=simulate_user_navigation, 
        args=(40.4400, -79.9950, 40.4425, -79.9945, 2),  # 2 hour parking
        daemon=True
    ).start()
    
    app.run(debug=True, use_reloader=False)