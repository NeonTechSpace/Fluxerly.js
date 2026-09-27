// Writes one line to each output stream and exits before joining the supervisor protocol
console.log("child stdout line")
console.error("child stderr line")
process.exitCode = 3
