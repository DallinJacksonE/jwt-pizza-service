#!/bin/bash

# Check if host is provided as a command line argument
if [ -z "$1" ]; then
  echo "Usage: $0 <host>"
  echo "Example: $0 http://localhost:3000"
  exit 1
fi
host=$1

# Trap SIGINT (Ctrl+C) to execute the cleanup function
cleanup() {
  echo "Terminating background processes..."
  kill $pid1 $pid2 $pid3 $pid4 $pid5 $pid6
  exit 0
}
trap cleanup SIGINT

# Wrap curl command to return HTTP response codes
execute_curl() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

# Function to register a user
register() {
  curl -s -o /dev/null -X POST "$host/api/auth" -d "{\"name\":\"$1\", \"email\":\"$2\", \"password\":\"$3\"}" -H 'Content-Type: application/json'
}

# Function to login and get a token
login() {
  response=$(curl -s -X PUT "$host/api/auth" -d "{\"email\":\"$1\", \"password\":\"$2\"}" -H 'Content-Type: application/json')
  # Check if curl failed or returned an error message instead of JSON
  if ! [[ "$response" == *"token"* ]]; then
    echo ""
    return
  fi
  echo "$response" | grep -o '"token":"[^"]*"' | cut -d'"' -f4
}

# --- INITIAL REGISTRATION ---
echo "Registering default test users..."
register "Franchise Owner" "f@jwt.com" "franchisee"
register "Hungry Diner" "d@jwt.com" "diner"

# Simulate a user requesting the menu every 3 seconds
while true; do
  result=$(execute_curl "$host/api/order/menu")
  echo "Requesting menu..." $result
  sleep 3
done &
pid1=$!

# Simulate a user with an invalid email and password every 25 seconds
while true; do
  result=$(execute_curl -X PUT "$host/api/auth" -d '{"email":"unknown@jwt.com", "password":"bad"}' -H 'Content-Type: application/json')
  echo "Logging in with invalid credentials..." $result
  sleep 25
done &
pid2=$!

# Simulate a franchisee logging in every two minutes
while true; do
  token=$(login "f@jwt.com" "franchisee")
  echo "Login franchisee..." $( [ -z "$token" ] && echo "false" || echo "true" )
  sleep 110
  if [ -n "$token" ]; then
    result=$(execute_curl -X DELETE "$host/api/auth" -H "Authorization: Bearer $token")
    echo "Logging out franchisee..." $result
  fi
  sleep 10
done &
pid3=$!

# Simulate a diner ordering a pizza every 50 seconds
while true; do
  token=$(login "d@jwt.com" "diner")
  if [ -z "$token" ]; then
    echo "Login failed, skipping order..."
    sleep 10
    continue
  fi
  echo "Login diner... true"
  result=$(execute_curl -X POST "$host/api/order" -H 'Content-Type: application/json' -d '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }]}' -H "Authorization: Bearer $token")
  echo "Bought a pizza..." $result
  sleep 20
  result=$(execute_curl -X DELETE "$host/api/auth" -H "Authorization: Bearer $token")
  echo "Logging out diner..." $result
  sleep 30
done &
pid4=$!

# Simulate a failed pizza order every 5 minutes
while true; do
  token=$(login "d@jwt.com" "diner")
  if [ -z "$token" ]; then
    echo "Login hungry diner failed, skipping..."
    sleep 10
    continue
  fi
  echo "Login hungry diner... true"

  items='{ "menuId": 1, "description": "Veggie", "price": 0.05 }'
  for (( i=0; i < 21; i++ ))
  do items+=', { "menuId": 1, "description": "Veggie", "price": 0.05 }'
  done
  
  result=$(execute_curl -X POST "$host/api/order" -H 'Content-Type: application/json' -d "{\"franchiseId\": 1, \"storeId\":1, \"items\":[$items]}" -H "Authorization: Bearer $token")
  echo "Bought too many pizzas..." $result  
  sleep 5
  result=$(execute_curl -X DELETE "$host/api/auth" -H "Authorization: Bearer $token")
  echo "Logging out hungry diner..." $result
  sleep 295
done &
pid5=$!

# Simulate a new user registering every 60 seconds
while true; do
  random_string=$(tr -dc A-Za-z0-9 </dev/urandom | head -c 8)
  result=$(execute_curl -X POST "$host/api/auth" -H 'Content-Type: application/json' -d "{\"name\":\"test_$random_string\", \"email\":\"test_$random_string@jwt.com\", \"password\":\"diner\"}")
  echo "Registered new user test_$random_string..." $result
  sleep 60
done &
pid6=$!

# Wait for the background processes to complete
wait $pid1 $pid2 $pid3 $pid4 $pid5 $pid6