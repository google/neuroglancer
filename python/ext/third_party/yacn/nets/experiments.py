from git import Repo
import os.path

repo_root = os.path.normpath(os.path.dirname(__file__)+'../..')

def save_experiment(experiment_name):
    repo = Repo(repo_root)
    old_branch = repo.active_branch
    old_commit = repo.commit()
    new_branch = repo.create_head(experiment_name)  
    new_branch.checkout()
    repo.index.add("*")
    repo.index.commit("Modifications made to commit {} from branch {}"
    .format(old_commit,old_branch))
    old_branch.checkout()
    repo.git.rebase(experiment_name)
    repo.git.reset('HEAD^')
