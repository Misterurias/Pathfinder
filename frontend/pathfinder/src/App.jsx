import React, { useEffect, useState, useRef } from "react";
import { MapPin, Bell, Car, Navigation, DollarSign, Search } from "lucide-react";

// ---------------------- TRIE FOR ADDRESS AUTOCOMPLETE ----------------------
class TrieNode {
  constructor() {
    this.children = {};
    this.isEnd = false;
    this.fullAddress = null;
    this.coords = null;
  }
}

class Trie {
  constructor() {
    this.root = new TrieNode();
  }

  insert(address, coords) {
    let node = this.root;
    const normalized = address.toLowerCase();
    for (let char of normalized) {
      if (!node.children[char]) node.children[char] = new TrieNode();
      node = node.children[char];
    }
    node.isEnd = true;
    node.fullAddress = address;
    node.coords = coords;
  }

  search(prefix) {
    const results = [];
    let node = this.root;
    const normalized = prefix.toLowerCase();

    for (let char of normalized) {
      if (!node.children[char]) return results;
      node = node.children[char];
    }

    const dfs = (currentNode) => {
      if (currentNode.isEnd && results.length < 5) {
        results.push({
          address: currentNode.fullAddress,
          coords: currentNode.coords
        });
      }
      for (let char in currentNode.children) {
        if (results.length >= 5) break;
        dfs(currentNode.children[char]);
      }
    };

    dfs(node);
    return results;
  }
}

export default function PathfinderUI() {

  const API = "https://pathfinder-copy-production.up.railway.app/"
  const LOCALAPI = "http://localhost:5050/api"
  // Location state
  const [userLocation, setUserLocation] = useState({ lat: 40.4400, lng: -79.9950 });
  const [destinationSearch, setDestinationSearch] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [destination, setDestination] = useState({ lat: 40.4425, lng: -79.9945, address: "" });
  const [duration, setDuration] = useState(2);
  
  // Parking state
  const [parking, setParking] = useState(null);
  const [alternatives, setAlternatives] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [pendingReroute, setPendingReroute] = useState(null);
  const [reservedSpot, setReservedSpot] = useState(null);
  const [showPayment, setShowPayment] = useState(false);
  const [tripStats, setTripStats] = useState({
    timeSaved: 0,
    moneySaved: 0,
    tripsCompleted: 0
  });
  
  // Auth state
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [priceWeight, setPriceWeight] = useState(30);
  
  // Connection state
  const [isConnected, setIsConnected] = useState(false);
  const [isTrackingGPS, setIsTrackingGPS] = useState(false);
  const [gpsError, setGpsError] = useState(null);
  const trieRef = useRef(new Trie());
  const pollIntervalRef = useRef(null);
  const gpsWatchIdRef = useRef(null);

  // ---------------------- INITIALIZE ADDRESS TRIE ----------------------
  useEffect(() => {
    const pittsburghAddresses = [
      { address: "Carnegie Mellon University", lat: 40.4433, lng: -79.9436 },
      { address: "University of Pittsburgh", lat: 40.4444, lng: -79.9608 },
      { address: "PNC Park", lat: 40.4469, lng: -80.0058 },
      { address: "Heinz Field", lat: 40.4468, lng: -80.0158 },
      { address: "Market Square", lat: 40.4392, lng: -80.0003 },
      { address: "Point State Park", lat: 40.4414, lng: -80.0095 },
      { address: "Phipps Conservatory", lat: 40.4382, lng: -79.9490 },
      { address: "Strip District", lat: 40.4515, lng: -79.9778 },
      { address: "Station Square", lat: 40.4350, lng: -80.0050 },
      { address: "South Side Works", lat: 40.4286, lng: -79.9632 }
    ];
    
    pittsburghAddresses.forEach(place => {
      trieRef.current.insert(place.address, { lat: place.lat, lng: place.lng });
    });
  }, []);

  // ---------------------- BACKEND CONNECTION VIA REST API ----------------------
  useEffect(() => {
    // Check if backend is available
    const checkConnection = async () => {
      try {
        const response = await fetch(`${API}/health`, {
          method: 'GET',
          mode: 'cors'
        });
        if (response.ok) {
          setIsConnected(true);
          addNotification("💡 Connected to Pathfinder", "info");
        }
      } catch (error) {
        console.log("Backend connection simulated for demo");
        setIsConnected(true);
      }
    };
    
    checkConnection();
    
    // Add helpful hints
    setTimeout(() => {
      addNotification("💡 Tip: Use testuser / password123 to login", "info");
    }, 1000);
  }, []);

  // ---------------------- GPS TRACKING ----------------------
  useEffect(() => {
    // Check if GPS is available
    if (!navigator.geolocation) {
      setGpsError("GPS not supported by your browser");
      addNotification("⚠️ GPS not available - using manual location", "warning");
      return;
    }

    // Start watching GPS position
    startGPSTracking();

    return () => {
      stopGPSTracking();
    };
  }, [destination, isLoggedIn]);

  const startGPSTracking = () => {
    if (gpsWatchIdRef.current) return; // Already tracking

    addNotification("📍 Starting GPS tracking...", "info");

    gpsWatchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const newLat = position.coords.latitude;
        const newLng = position.coords.longitude;
        const accuracy = position.coords.accuracy;

        // Update user location
        setUserLocation({ lat: newLat, lng: newLng });
        setIsTrackingGPS(true);
        setGpsError(null);

        // Only log significant movements (>10 meters)
        const oldLat = userLocation.lat;
        const oldLng = userLocation.lng;
        const distance = calculateDistance(oldLat, oldLng, newLat, newLng);

        if (distance > 0.01) { // ~10 meters
          console.log(`📍 GPS Update: ${newLat.toFixed(6)}, ${newLng.toFixed(6)} (±${accuracy}m)`);
          
          // Send position update to backend
          sendPositionUpdate(newLat, newLng);
          
          // Check if we should reroute based on new position
          if (parking && destination.lat) {
            checkForBetterParking(newLat, newLng);
          }
        }
      },
      (error) => {
        console.error("GPS Error:", error);
        setIsTrackingGPS(false);
        
        switch(error.code) {
          case error.PERMISSION_DENIED:
            setGpsError("Location permission denied");
            addNotification("⚠️ Please enable location permissions", "error");
            break;
          case error.POSITION_UNAVAILABLE:
            setGpsError("Location unavailable");
            addNotification("⚠️ GPS signal lost", "warning");
            break;
          case error.TIMEOUT:
            setGpsError("Location request timeout");
            break;
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 5050 // Use cached position if less than 5 seconds old
      }
    );
  };

  const stopGPSTracking = () => {
    if (gpsWatchIdRef.current) {
      navigator.geolocation.clearWatch(gpsWatchIdRef.current);
      gpsWatchIdRef.current = null;
      setIsTrackingGPS(false);
      addNotification("📍 GPS tracking stopped", "info");
    }
  };

  // Send position update to backend
  const sendPositionUpdate = async (lat, lng) => {
    if (!isConnected || !currentUser) return;

    try {
      await fetch(`${API}/update_position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: currentUser,
          lat: lat,
          lng: lng,
          timestamp: Date.now()
        })
      });
    } catch (error) {
      // Silently fail - backend might not have this endpoint yet
      console.log("Position update failed (backend may not support this yet)");
    }
  };

  // Calculate distance between two points (in km)
  const calculateDistance = (lat1, lng1, lat2, lng2) => {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  };

  // Check if user's new position means a different parking is better
  const checkForBetterParking = async (currentLat, currentLng) => {
    if (!parking || !destination.lat) return;

    // Calculate distances from new position
    const distanceToCurrentParking = calculateDistance(
      currentLat, currentLng, 
      parking.lat || 40.4415, parking.lng || -79.9930
    );

    // If we're within 100m of parking, don't suggest changes
    if (distanceToCurrentParking < 0.1) {
      addNotification("🎯 Almost there! Continue to your parking.", "success");
      return;
    }

    // Check if alternatives are now better
    if (alternatives.length > 0) {
      for (const alt of alternatives) {
        const distanceToAlt = calculateDistance(
          currentLat, currentLng,
          alt.lat || 40.4420, alt.lng || -79.9965
        );

        // If alternative is now significantly closer (>200m difference)
        if (distanceToCurrentParking - distanceToAlt > 0.2) {
          setPendingReroute({
            message: `You're now closer to ${alt.name}. Switch parking?`,
            new_garage: alt.name,
            impact: `saves ${Math.round((distanceToCurrentParking - distanceToAlt) * 1000)}m drive time`
          });
          addNotification("🔔 Better parking option based on your location!", "warning");
          break;
        }
      }
    }
  };

  // ---------------------- ADDRESS AUTOCOMPLETE ----------------------
  const handleDestinationSearch = (e) => {
    const value = e.target.value;
    setDestinationSearch(value);
    
    if (value.length > 1) {
      const results = trieRef.current.search(value);
      setSuggestions(results);
    } else {
      setSuggestions([]);
    }
  };

  const selectSuggestion = (suggestion) => {
    setDestination({
      lat: suggestion.coords.lat,
      lng: suggestion.coords.lng,
      address: suggestion.address
    });
    setDestinationSearch(suggestion.address);
    setSuggestions([]);
    addNotification(`📍 Destination set to ${suggestion.address}`, "success");
  };

  // ---------------------- AUTH FUNCTIONS ----------------------
  const handleLogin = async () => {
    try {
      const response = await fetch(`${API}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      
      if (response.ok) {
        const data = await response.json();
        setIsLoggedIn(true);
        setCurrentUser(username);
        addNotification("✓ Logged in successfully", "success");
        
        // Load user preferences
        loadPreferences();
      } else {
        const error = await response.json();
        addNotification(error.error || "Login failed", "error");
      }
    } catch (err) {
      // Fallback for demo
      if (username === "testuser" && password === "password123") {
        setIsLoggedIn(true);
        setCurrentUser(username);
        addNotification("✓ Logged in successfully", "success");
      } else {
        addNotification("Invalid credentials. Try testuser/password123", "error");
      }
    }
  };

  const handleRegister = async () => {
    if (!username || password.length < 6) {
      addNotification("Password must be at least 6 characters", "error");
      return;
    }
    
    try {
      const response = await fetch(`${API}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      
      if (response.ok) {
        addNotification("✓ Registration successful! Please login.", "success");
        setPassword("");
      } else {
        const error = await response.json();
        addNotification(error.error || "Registration failed", "error");
      }
    } catch (err) {
      addNotification("✓ Registration successful! Please login.", "success");
      setPassword("");
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${API}/logout`, { method: 'POST' });
    } catch (err) {
      // Ignore errors
    }
    
    setIsLoggedIn(false);
    setCurrentUser(null);
    setParking(null);
    addNotification("Logged out", "info");
    
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }
  };
  
  const loadPreferences = async () => {
    try {
      const response = await fetch(`${API}/preferences`);
      if (response.ok) {
        const data = await response.json();
        setPriceWeight(data.price_weight * 100);
      }
    } catch (err) {
      // Use default
    }
  };
  
  const savePreferences = async () => {
    try {
      const response = await fetch(`${API}/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price_weight: priceWeight / 100 })
      });
      
      if (response.ok) {
        addNotification("✓ Preferences saved!", "success");
      }
    } catch (err) {
      addNotification("✓ Preferences saved!", "success");
    }
  };

  // ---------------------- FIND PARKING ----------------------
  const findParking = async () => {
    if (!destination.lat || !destination.lng) {
      addNotification("Please select a destination first", "error");
      return;
    }

    addNotification("🔍 Finding best parking...", "info");
    
    // Use REST API to find parking
    try {
      const response = await fetch(`${API}/find_parking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_lat: userLocation.lat,
          user_lng: userLocation.lng,
          dest_lat: destination.lat,
          dest_lng: destination.lng,
          duration: duration
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        setParking(data.best_parking);
        setAlternatives(data.alternatives || []);
        addNotification(`✓ Found parking at ${data.best_parking.name}`, "success");
        
        // Start polling for availability changes
        startPollingAvailability();
      }
    } catch (error) {
      // Fallback to simulated data for demo
      simulateParkingData();
    }
  };
  
  const simulateParkingData = () => {
    const mockParking = {
      name: "Garage B",
      address: "456 Fifth Ave",
      price_per_hour: 2.0,
      estimated_cost: duration * 2.0,
      available_spots: 80,
      total_spots: 150,
      drive_distance: "350m",
      walk_distance: "200m",
      payment_methods: ["credit_card", "app"]
    };
    
    const mockAlternatives = [
      {
        name: "Garage C",
        address: "789 Penn Ave",
        estimated_cost: duration * 1.5,
        reason: "saves $" + ((duration * 2.0) - (duration * 1.5)).toFixed(2) + ", 150m longer walk",
        available_spots: 20,
        drive_distance: "500m",
        walk_distance: "350m"
      },
      {
        name: "Garage A",
        address: "123 Forbes Ave",
        estimated_cost: duration * 3.0,
        reason: "costs $" + ((duration * 3.0) - (duration * 2.0)).toFixed(2) + " more, 100m shorter walk",
        available_spots: 45,
        drive_distance: "250m",
        walk_distance: "100m"
      }
    ];
    
    setParking(mockParking);
    setAlternatives(mockAlternatives);
    addNotification(`✓ Found parking at ${mockParking.name}`, "success");
    
    // Simulate a reroute notification after 5 seconds
    setTimeout(() => {
      setPendingReroute({
        message: "Garage B is filling up fast. Garage C has better availability now.",
        new_garage: "Garage C",
        impact: "saves $1.00 and adds 150m walk"
      });
      addNotification("🔔 Better parking option available!", "warning");
    }, 5050);
  };
  
  // Poll for parking availability changes
  const startPollingAvailability = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }
    
    pollIntervalRef.current = setInterval(async () => {
      try {
        const response = await fetch(`${API}/check_availability`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            current_parking: parking?.name,
            dest_lat: destination.lat,
            dest_lng: destination.lng
          })
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.reroute_recommended) {
            setPendingReroute(data.reroute_info);
            addNotification("🔔 Better parking option available!", "warning");
          }
        }
      } catch (error) {
        // Silently fail for demo
        console.log("Polling error (simulated environment)");
      }
    }, 10000); // Poll every 10 seconds
  };
  
  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  // ---------------------- RESERVATION SYSTEM ----------------------
  const reserveSpot = async (parkingOption) => {
    try {
      const response = await fetch(`${API}/reserve_spot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          garage_name: parkingOption.name,
          user_id: currentUser,
          duration: duration,
          estimated_cost: parkingOption.estimated_cost
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        setReservedSpot({
          ...parkingOption,
          reservation_id: data.reservation_id,
          confirmation_code: data.confirmation_code,
          expires_at: data.expires_at
        });
        setShowPayment(true);
        addNotification(`✓ Reserved spot at ${parkingOption.name} for 15 minutes`, "success");
        
        // Calculate time saved (average 8 min circling avoided)
        const timeSaved = 8;
        setTripStats(prev => ({
          ...prev,
          timeSaved: prev.timeSaved + timeSaved
        }));
      }
    } catch (error) {
      // Demo fallback
      setReservedSpot({
        ...parkingOption,
        reservation_id: `RES-${Date.now()}`,
        confirmation_code: `CB${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
        expires_at: new Date(Date.now() + 15 * 60000).toLocaleTimeString()
      });
      setShowPayment(true);
      addNotification(`✓ Reserved spot at ${parkingOption.name} for 15 minutes`, "success");
      
      const timeSaved = 8;
      setTripStats(prev => ({
        ...prev,
        timeSaved: prev.timeSaved + timeSaved
      }));
    }
  };
  
  // ---------------------- PAYMENT SYSTEM ----------------------
  const completePayment = async (paymentMethod) => {
    if (!reservedSpot) return;
    
    try {
      const response = await fetch(`${API}/complete_payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservation_id: reservedSpot.reservation_id,
          payment_method: paymentMethod,
          amount: reservedSpot.estimated_cost
        })
      });
      
      if (response.ok) {
        addNotification(`✓ Payment successful! Parking confirmed at ${reservedSpot.name}`, "success");
        setShowPayment(false);
        
        // Update trip stats
        setTripStats(prev => ({
          ...prev,
          tripsCompleted: prev.tripsCompleted + 1
        }));
        
        // Open navigation
        openNavigation(reservedSpot);
      }
    } catch (error) {
      // Demo fallback
      addNotification(`✓ Payment successful! Parking confirmed at ${reservedSpot.name}`, "success");
      setShowPayment(false);
      
      setTripStats(prev => ({
        ...prev,
        tripsCompleted: prev.tripsCompleted + 1
      }));
      
      openNavigation(reservedSpot);
    }
  };
  
  // ---------------------- NAVIGATION INTEGRATION ----------------------
  const openNavigation = (parkingSpot) => {
    // Get coordinates for navigation
    const destLat = parkingSpot.lat || 40.4415;
    const destLng = parkingSpot.lng || -79.9930;
    
    // Open in Google Maps (works on mobile)
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${userLocation.lat},${userLocation.lng}&destination=${destLat},${destLng}&travelmode=driving`;
    
    addNotification(`📍 Opening navigation to ${parkingSpot.name}`, "info");
    
    // In production, this would open the maps app
    console.log("Navigation URL:", mapsUrl);
    
    // Start tracking arrival
    startArrivalTracking(parkingSpot);
  };
  
  const startArrivalTracking = (parkingSpot) => {
    addNotification("🚗 Navigate to your parking spot. We'll notify you when you arrive.", "info");
    
    // Simulate arrival after 30 seconds for demo
    setTimeout(() => {
      addNotification(`✓ You've arrived at ${parkingSpot.name}! Enjoy your visit.`, "success");
      addNotification(`💾 Trip data sent to city partners for traffic optimization`, "info");
    }, 30000);
  };
  const acceptReroute = () => {
    if (pendingReroute) {
      addNotification(`✓ Rerouting to ${pendingReroute.new_garage}`, "success");
      
      // Update parking to the alternative
      const newParking = alternatives.find(a => a.name === pendingReroute.new_garage);
      if (newParking) {
        setParking({
          ...newParking,
          price_per_hour: newParking.estimated_cost / duration,
          total_spots: 75,
          payment_methods: ["credit_card", "app", "cash"]
        });
      }
      
      setPendingReroute(null);
    }
  };

  const declineReroute = () => {
    addNotification("Keeping current route", "info");
    setPendingReroute(null);
  };

  // ---------------------- NOTIFICATIONS ----------------------
  const addNotification = (message, type = "info") => {
    const newNotif = {
      id: Date.now(),
      message,
      type,
      timestamp: new Date().toLocaleTimeString()
    };
    setNotifications(prev => [newNotif, ...prev].slice(0, 8));
  };

  // ---------------------- PREFERENCE LABEL ----------------------
  const getPreferenceLabel = () => {
    if (priceWeight < 20) return "Distance Priority";
    if (priceWeight < 40) return "Balanced";
    if (priceWeight < 60) return "Price Priority";
    return "Max Savings";
  };

  // ---------------------- RENDER ----------------------
  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-600 to-indigo-700 p-4">
      <div className="max-w-2xl mx-auto space-y-4">
        {/* Header */}
        <div className="text-center py-6">
          <h1 className="text-4xl font-bold text-white flex items-center justify-center gap-3">
            <Car className="w-10 h-10" />
            Pathfinder
          </h1>
          <p className="text-purple-100 mt-2">Smart Parking Navigator with Address Search</p>
          <div className={`inline-block px-3 py-1 rounded-full text-sm mt-2 ${
            isConnected ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
          }`}>
            {isConnected ? '✓ Connected' : '✗ Disconnected'}
          </div>
          <div className={`inline-block px-3 py-1 rounded-full text-sm mt-2 ml-2 ${
            isTrackingGPS ? 'bg-blue-500 text-white' : 'bg-gray-500 text-white'
          }`}>
            {isTrackingGPS ? '📍 GPS Active' : '📍 GPS Off'}
          </div>
          {gpsError && (
            <div className="text-red-100 text-sm mt-2">
              {gpsError}
            </div>
          )}
        </div>

        {/* Auth Card */}
        {!isLoggedIn ? (
          <div className="bg-white rounded-lg shadow-xl p-6">
            <h2 className="text-xl font-semibold mb-4">Login or Register</h2>
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full p-3 border-2 border-gray-200 rounded-lg focus:border-purple-500 outline-none"
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleLogin()}
                className="w-full p-3 border-2 border-gray-200 rounded-lg focus:border-purple-500 outline-none"
              />
              <div className="flex gap-3">
                <button
                  onClick={handleLogin}
                  className="flex-1 bg-purple-600 text-white py-3 rounded-lg font-semibold hover:bg-purple-700 transition"
                >
                  Login
                </button>
                <button
                  onClick={handleRegister}
                  className="flex-1 bg-gray-600 text-white py-3 rounded-lg font-semibold hover:bg-gray-700 transition"
                >
                  Register
                </button>
              </div>
              <p className="text-sm text-gray-500 text-center">
                Test account: <span className="font-mono">testuser / password123</span>
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* User Info */}
            <div className="bg-green-50 rounded-lg p-4 flex justify-between items-center">
              <div>
                <span className="font-semibold text-green-800">
                  👤 {currentUser}
                </span>
                <div className="text-sm text-gray-600 mt-1">
                  📍 {userLocation.lat.toFixed(6)}, {userLocation.lng.toFixed(6)}
                  {isTrackingGPS && <span className="ml-2 text-blue-600">● Live</span>}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => isTrackingGPS ? stopGPSTracking() : startGPSTracking()}
                  className={`text-sm px-4 py-2 rounded-lg ${
                    isTrackingGPS ? 'bg-blue-600 text-white' : 'bg-gray-300 text-gray-700'
                  }`}
                >
                  {isTrackingGPS ? '📍 Tracking' : '📍 Start GPS'}
                </button>
                <button
                  onClick={handleLogout}
                  className="text-sm bg-gray-600 text-white px-4 py-2 rounded-lg hover:bg-gray-700"
                >
                  Logout
                </button>
              </div>
            </div>

            {/* Preferences */}
            <div className="bg-blue-50 rounded-lg p-4">
              <label className="block font-semibold mb-2">
                Preference: Distance vs Price
              </label>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-600 min-w-[100px]">Distance</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={priceWeight}
                  onChange={(e) => setPriceWeight(parseInt(e.target.value))}
                  className="flex-1"
                />
                <span className="text-sm font-semibold min-w-[100px] text-right">
                  {getPreferenceLabel()}
                </span>
              </div>
              <button
                onClick={savePreferences}
                className="mt-2 w-full bg-blue-600 text-white py-2 rounded-lg text-sm hover:bg-blue-700"
              >
                Save Preferences
              </button>
            </div>

            {/* Destination Search with Autocomplete */}
            <div className="bg-white rounded-lg shadow-xl p-6">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Search className="text-purple-600" />
                Search Destination
              </h2>
              
              <div className="relative">
                <input
                  type="text"
                  value={destinationSearch}
                  onChange={handleDestinationSearch}
                  placeholder="Search for landmarks, universities, parks..."
                  className="w-full p-3 border-2 border-gray-200 rounded-lg focus:border-purple-500 outline-none"
                />
                
                {suggestions.length > 0 && (
                  <div className="absolute z-10 w-full bg-white border-2 border-gray-200 rounded-lg mt-1 shadow-lg max-h-60 overflow-y-auto">
                    {suggestions.map((suggestion, idx) => (
                      <div
                        key={idx}
                        onClick={() => selectSuggestion(suggestion)}
                        className="p-3 hover:bg-purple-50 cursor-pointer border-b last:border-b-0 flex items-center gap-2"
                      >
                        <MapPin className="w-4 h-4 text-purple-600" />
                        <span className="font-medium">{suggestion.address}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {destination.address && (
                <div className="mt-3 p-3 bg-green-50 rounded-lg text-sm">
                  <strong>Selected:</strong> {destination.address}
                  <div className="text-gray-600 mt-1">
                    📍 {destination.lat.toFixed(4)}, {destination.lng.toFixed(4)}
                  </div>
                </div>
              )}

              <div className="mt-4">
                <label className="block text-sm font-medium mb-1">Parking Duration (hours)</label>
                <input
                  type="number"
                  step="0.5"
                  value={duration}
                  onChange={(e) => setDuration(parseFloat(e.target.value))}
                  className="w-full p-2 border-2 border-gray-200 rounded-lg"
                />
              </div>

              <button
                onClick={findParking}
                className="w-full bg-purple-600 text-white py-3 rounded-lg font-semibold hover:bg-purple-700 transition flex items-center justify-center gap-2 mt-4"
              >
                <Navigation className="w-5 h-5" />
                Find Parking
              </button>
            </div>

            {/* Parking Recommendation */}
            {parking && (
              <div className="bg-white rounded-lg shadow-xl p-6">
                <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                  <MapPin className="text-purple-600" />
                  Recommended Parking
                </h2>

                <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-4">
                  <div className="font-semibold text-yellow-800 mb-1">📍 Journey Overview</div>
                  <div className="text-sm">🚗 Drive to parking: {parking.drive_distance}</div>
                  <div className="text-sm">🚶 Walk to destination: {parking.walk_distance}</div>
                </div>

                <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                  <h3 className="font-bold text-lg text-purple-700">🅿️ {parking.name}</h3>
                  
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="font-semibold text-gray-600">Address:</span>
                      <div>{parking.address}</div>
                    </div>
                    <div>
                      <span className="font-semibold text-gray-600">Total Cost:</span>
                      <div className="flex items-center gap-1 text-lg font-bold text-green-600">
                        <DollarSign className="w-5 h-5" />
                        {parking.estimated_cost.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <span className="font-semibold text-gray-600">Hourly Rate:</span>
                      <div>${parking.price_per_hour}/hr</div>
                    </div>
                    <div>
                      <span className="font-semibold text-gray-600">Available:</span>
                      <div>{parking.available_spots}/{parking.total_spots} spots</div>
                    </div>
                  </div>
                  
                  {parking.payment_methods && (
                    <div className="text-sm">
                      <span className="font-semibold text-gray-600">Payment:</span>
                      <span className="ml-2">{parking.payment_methods.join(', ')}</span>
                    </div>
                  )}
                  
                  <button
                    onClick={() => reserveSpot(parking)}
                    className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition flex items-center justify-center gap-2 mt-3"
                    disabled={reservedSpot !== null}
                  >
                    {reservedSpot ? '✓ Reserved' : '🎫 Reserve & Pay'}
                  </button>
                </div>

                {alternatives.length > 0 && (
                  <div className="mt-4">
                    <h3 className="font-semibold mb-2">Alternative Options</h3>
                    {alternatives.map((alt) => (
                      <div key={alt.name} className="border-2 border-gray-200 rounded-lg p-3 mb-2 hover:border-purple-400 transition">
                        <div className="flex justify-between items-start">
                          <div>
                            <div className="font-semibold">{alt.name}</div>
                            <div className="text-sm text-gray-600">{alt.reason}</div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold text-green-600">${alt.estimated_cost.toFixed(2)}</div>
                            <div className="text-xs text-gray-500">{alt.available_spots} spots</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Reroute Prompt */}
            {pendingReroute && (
              <div className="bg-yellow-50 border-2 border-yellow-400 rounded-lg p-6 animate-pulse">
                <div className="flex items-start gap-3 mb-4">
                  <Bell className="w-6 h-6 text-yellow-600 mt-1" />
                  <div>
                    <p className="font-semibold text-lg">{pendingReroute.message}</p>
                    <p className="text-sm text-gray-600 mt-1">Impact: {pendingReroute.impact}</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <button
                    onClick={acceptReroute}
                    className="flex-1 bg-purple-600 text-white py-3 rounded-lg font-semibold hover:bg-purple-700"
                  >
                    ✓ Accept Reroute
                  </button>
                  <button
                    onClick={declineReroute}
                    className="flex-1 bg-gray-300 text-gray-700 py-3 rounded-lg font-semibold hover:bg-gray-400"
                  >
                    ✗ Keep Current
                  </button>
                </div>
              </div>
            )}

            {/* Payment Modal */}
            {showPayment && reservedSpot && (
              <div className="bg-white border-2 border-purple-400 rounded-lg p-6 shadow-2xl">
                <h2 className="text-2xl font-bold mb-4 text-purple-700">Complete Payment</h2>
                
                <div className="bg-purple-50 rounded-lg p-4 mb-4">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-semibold">Reservation:</span>
                    <span className="font-mono text-sm">{reservedSpot.confirmation_code}</span>
                  </div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-semibold">Garage:</span>
                    <span>{reservedSpot.name}</span>
                  </div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-semibold">Duration:</span>
                    <span>{duration} hours</span>
                  </div>
                  <div className="flex justify-between items-center text-lg font-bold text-green-600">
                    <span>Total:</span>
                    <span>${reservedSpot.estimated_cost.toFixed(2)}</span>
                  </div>
                  <div className="text-xs text-gray-600 mt-2">
                    Expires: {reservedSpot.expires_at}
                  </div>
                </div>
                
                <div className="space-y-3">
                  <button
                    onClick={() => completePayment('credit_card')}
                    className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 flex items-center justify-center gap-2"
                  >
                    💳 Pay with Credit Card
                  </button>
                  <button
                    onClick={() => completePayment('app')}
                    className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 flex items-center justify-center gap-2"
                  >
                    📱 Pay with App
                  </button>
                  <button
                    onClick={() => setShowPayment(false)}
                    className="w-full bg-gray-300 text-gray-700 py-2 rounded-lg hover:bg-gray-400"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Trip Stats / ROI Dashboard */}
            <div className="bg-white rounded-lg shadow-xl p-6">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                📊 Your Impact
              </h2>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-green-50 rounded-lg p-4 text-center">
                  <div className="text-3xl font-bold text-green-600">{tripStats.timeSaved}</div>
                  <div className="text-sm text-gray-600 mt-1">Minutes Saved</div>
                </div>
                <div className="bg-blue-50 rounded-lg p-4 text-center">
                  <div className="text-3xl font-bold text-blue-600">{tripStats.tripsCompleted}</div>
                  <div className="text-sm text-gray-600 mt-1">Trips</div>
                </div>
                <div className="bg-purple-50 rounded-lg p-4 text-center">
                  <div className="text-3xl font-bold text-purple-600">
                    {tripStats.timeSaved > 0 ? Math.round(tripStats.timeSaved * 0.15) : 0}
                  </div>
                  <div className="text-sm text-gray-600 mt-1">lbs CO₂ Saved</div>
                </div>
              </div>
              <div className="mt-4 text-xs text-gray-500 text-center">
                Your data helps Pittsburgh optimize parking and reduce congestion
              </div>
            </div>

            {/* Notifications */}
            <div className="bg-white rounded-lg shadow-xl p-6">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Bell className="text-purple-600" />
                Recent Activity
              </h2>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {notifications.length === 0 ? (
                  <p className="text-gray-400 text-center py-4">No notifications</p>
                ) : (
                  notifications.map((n) => (
                    <div
                      key={n.id}
                      className={`p-3 rounded-lg border-l-4 ${
                        n.type === 'success' ? 'bg-green-50 border-green-500' :
                        n.type === 'error' ? 'bg-red-50 border-red-500' :
                        n.type === 'warning' ? 'bg-yellow-50 border-yellow-500' :
                        'bg-blue-50 border-blue-500'
                      }`}
                    >
                      <div className="flex justify-between items-start">
                        <p className="font-medium text-sm">{n.message}</p>
                        <span className="text-xs text-gray-500 ml-2">{n.timestamp}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}