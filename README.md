# smart-brew-aiSmart Brew AI
Smart Brew AI is a coffee shop workflow tool designed to help baristas manage incoming drink orders during busy rush periods.
The MVP focuses on one core problem: helping baristas quickly understand which order should be prepared next.
Problem
Coffee shop baristas often have to manage several customer orders at the same time during peak hours. Without a clear prioritization system, orders can become confusing, customers may wait longer, and employees can feel overwhelmed.
Solution
Smart Brew AI organizes incoming orders and recommends the order in which drinks should be prepared.
The goal is to reduce confusion, improve workflow, and help coffee shop teams serve customers more efficiently during busy shifts.
Target User
The primary user is a coffee shop barista working during a busy shift.
Coffee shop teams and managers may also benefit from a more organized order workflow.
MVP Goal
The MVP should answer one important question:
Can Smart Brew AI reduce rush-hour confusion by helping baristas know what drink to prepare next?Core MVP Features

Enter new customer orders
View all active orders
Organize orders by priority
Consider estimated preparation time
Recommend which order should be prepared next
Mark orders as completed
Update the order list automatically
MVP User Flow

The barista opens Smart Brew AI.
The barista enters a new customer order.
Smart Brew AI adds the order to the active queue.
The system organizes orders based on priority and preparation time.
The barista views the recommended order sequence.
The barista prepares the next suggested drink.
The barista marks the order as completed.
The system updates the remaining queue.
Example Order Information
Each order may include:
FieldDescriptionOrder NumberA unique number for the orderDrink NameThe drink the customer orderedSizeSmall, medium, or largeQuantityNumber of drinksPreparation TimeEstimated time neededPriorityNormal, high, or urgentTime ReceivedWhen the order was placedStatusWaiting, in progress, or completed
Recommended Tech Stack
A simple first version can be built with:

HTML
CSS
JavaScript
Local browser storage
A backend and database can be added later if the application needs saved orders, employee accounts, reporting, or multiple devices.
Suggested Project Structure
smart-brew-ai/
├── index.html
├── css/
│   └── styles.css
├── js/
│   ├── app.js
│   ├── orders.js
│   └── prioritization.js
├── assets/
│   └── images/
└── README.mdGetting Started
1. Clone the repository
git clone https://github.com/your-username/smart-brew-ai.git
cd smart-brew-ai2. Open the project
Open index.html directly in your browser or use a local development server.
Using Python:
python -m http.server 8000Then open:
http://localhost:8000You can also use the Live Server extension in Visual Studio Code.
How to Use the MVP

Open Smart Brew AI.
Add a new customer order.
Enter the drink information.
Submit the order.
Review the recommended order queue.
Begin preparing the first recommended drink.
Mark the order as completed.
Continue with the next suggested order.
Prioritization Logic
The first version can prioritize orders using simple rules such as:

Orders that have been waiting the longest move higher in the queue.
Faster drinks may be completed first when appropriate.
High-priority orders move above normal-priority orders.
Large or complex orders may be balanced with smaller orders to keep the line moving.
The exact rules should remain simple and understandable during the MVP stage.
MVP Scope
The first version should focus only on order entry, prioritization, and completion.
The MVP does not need:

QR code personalization
Inventory prediction
Customer accounts
Payment processing
Advanced machine learning
Employee scheduling
Detailed wait-time predictions
Integration with a point-of-sale system
These features can be explored after the main prioritization workflow works reliably.
Future Improvements

Estimated customer wait times
Inventory tracking and low-stock warnings
Personalized drink recommendations
QR code customer profiles
Point-of-sale integrations
Manager dashboards
Rush-hour performance reports
Multiple employee accounts
Order history
More advanced prioritization rules
Testing Checklist

Add a new order
Display active orders correctly
Sort orders in the expected sequence
Mark an order as in progress
Mark an order as completed
Remove completed orders from the active queue
Handle missing order information
Handle multiple orders with the same priority
Keep the interface readable during a busy queue
Confirm the application works on desktop and mobile screens
Suggested First Commits
Create initial project structure
Add basic README
Build order entry form
Display active order queue
Add order prioritization logic
Add complete order button
Improve responsive stylingEach meaningful change should have its own clear commit message.
Project Status
Smart Brew AI is currently in the MVP development stage.
The current focus is building a functional order queue that helps baristas decide what drink to prepare next.
Author
Priscilla Batroni
