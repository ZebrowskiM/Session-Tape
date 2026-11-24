# Run from PowerShell with GitHub CLI signed in as ZebrowskiM:
# gh auth refresh -h github.com -s project
# .\scripts\Sync-Roadmap.ps1
# To add later roadmap issues, pass -ProjectNumber with the number printed on first use.
[CmdletBinding()]
param([ValidateRange(1, 2147483647)][int]$ProjectNumber)

$ErrorActionPreference = 'Stop'
$owner = 'ZebrowskiM'
$repo = "$owner/Session-Tape"
$title = 'Session Tape Roadmap'
$viewName = 'By milestone'
$apiVersion = 'X-GitHub-Api-Version: 2026-03-10'

function Invoke-Gh([string[]]$Arguments) {
    $output = & gh @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub CLI failed during 'gh $($Arguments[0])'. Check the error above before retrying."
    }
    $output
}

$account = Invoke-Gh @('api', 'user') | ConvertFrom-Json
if ($account.login -ne $owner) { throw "Select the $owner GitHub CLI account first." }
$issues = @(Invoke-Gh @('api', '--paginate', "repos/$repo/issues?labels=roadmap&state=all&per_page=100",
    '--jq', '.[] | select(.pull_request == null) | .html_url'))
if ($issues.Count -eq 0) { throw "No roadmap issues found in $repo." }

if (!$ProjectNumber) {
    $projects = Invoke-Gh @('project', 'list', '--owner', $owner, '--limit', '1000', '--format', 'json') | ConvertFrom-Json
    $existing = @($projects.projects | Where-Object { $_.title -eq $title })
    if ($existing.Count) {
        throw "A project named '$title' already exists. Verify its number, then rerun with -ProjectNumber NUMBER."
    }
    $repositoryId = Invoke-Gh @('api', "repos/$repo", '--jq', '.node_id')
    $create = 'mutation($owner:ID!, $repo:ID!, $title:String!) { createProjectV2(input:{ownerId:$owner,repositoryId:$repo,title:$title}) { projectV2 { number } } }'
    $ProjectNumber = [int](Invoke-Gh @('api', 'graphql', '-f', "query=$create", '-f', "owner=$($account.node_id)",
        '-f', "repo=$repositoryId", '-f', "title=$title", '--jq', '.data.createProjectV2.projectV2.number'))
    Write-Host "Created project $ProjectNumber. To resume, rerun with -ProjectNumber $ProjectNumber."
}

$query = 'query($owner:String!, $number:Int!) { user(login:$owner) { projectV2(number:$number) { title url closed repositories(first:100){nodes{nameWithOwner}} views(first:100){nodes{number name layout}} } } }'
$project = Invoke-Gh @('api','graphql','-f',"query=$query",'-f',"owner=$owner",'-F',"number=$ProjectNumber",
    '--jq','.data.user.projectV2') | ConvertFrom-Json
if ($project.closed -or $project.title -ne $title -or $repo -notin $project.repositories.nodes.nameWithOwner) {
    throw "Project $ProjectNumber must be the open '$title' project linked to $repo."
}

$itemsQuery = 'query($owner:String!, $number:Int!, $endCursor:String) { user(login:$owner) { projectV2(number:$number) { items(first:100,after:$endCursor) { nodes { content { ... on Issue { url } } } pageInfo { hasNextPage endCursor } } } } }'
function Get-IssueUrls {
    Invoke-Gh @('api','graphql','--paginate','-f',"query=$itemsQuery",'-f',"owner=$owner",'-F',"number=$ProjectNumber",
        '--jq','.data.user.projectV2.items.nodes[].content.url // empty')
}
$members = @(Get-IssueUrls)
foreach ($issue in $issues) {
    if ($issue -notin $members) {
        Invoke-Gh @('project','item-add',"$ProjectNumber",'--owner',$owner,'--url',$issue) | Out-Null
    }
}
$members = @(Get-IssueUrls)
$missing = @($issues | Where-Object { $_ -notin $members })
if ($missing.Count) { throw "Board membership could not be verified for $($missing.Count) issues. Rerun with -ProjectNumber $ProjectNumber." }

$view = $project.views.nodes | Where-Object { $_.name -eq $viewName } | Select-Object -First 1
if ($view -and $view.layout -ne 'BOARD_LAYOUT') { throw "A non-board view already uses the name '$viewName'." }
if (!$view) {
    $fieldsUrl = "users/$owner/projectsV2/$ProjectNumber/fields?per_page=100"
    $fields = Invoke-Gh @('api', $fieldsUrl, '-H', $apiVersion) | ConvertFrom-Json
    $milestone = $fields | Where-Object { $_.name -eq 'Milestone' } | Select-Object -First 1
    if (!$milestone.id) { throw 'The project did not return its Milestone field.' }
    $viewsUrl = "users/$($account.id)/projectsV2/$ProjectNumber/views"
    $view = Invoke-Gh @('api', $viewsUrl, '--method', 'POST', '-H', $apiVersion, '-f', "name=$viewName",
        '-f', 'layout=board', '-F', "vertical_group_by[]=$($milestone.id)") | ConvertFrom-Json
}
Write-Host "Verified $($issues.Count) roadmap issues. Open $($project.url)/views/$($view.number)"
